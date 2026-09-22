import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractPagesPdfjs } from './pdfjs.js';

export interface PageContent {
  page: number;
  text: string;
  imageCount: number;
}

// Records which extraction backend produced the most recent result.
export let lastExtractionMethod = 'none';

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 300 }).toString('utf8');
}

function popplerAvailable(): boolean {
  try {
    run('pdftotext', ['-v']);
    return true;
  } catch {
    return false;
  }
}

export function getPageCount(pdfPath: string): number {
  try {
    const out = run('pdfinfo', [pdfPath]);
    const m = out.match(/Pages:\s+(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function imageCountsByPage(pdfPath: string): Map<number, number> {
  const counts = new Map<number, number>();
  try {
    const out = run('pdfimages', ['-list', pdfPath]);
    const lines = out.split('\n').slice(2);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const page = parseInt(cols[0], 10);
      if (Number.isFinite(page)) counts.set(page, (counts.get(page) || 0) + 1);
    }
  } catch {
    /* pdfimages unavailable or no images */
  }
  return counts;
}

function extractWithPoppler(pdfPath: string): PageContent[] {
  const raw = run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-']);
  const parts = raw.split('\f');
  const imgCounts = imageCountsByPage(pdfPath);
  const pages: PageContent[] = [];
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i];
    if (i === parts.length - 1 && text.trim() === '') continue;
    pages.push({ page: i + 1, text, imageCount: imgCounts.get(i + 1) || 0 });
  }
  return pages;
}

const textLen = (ps: PageContent[]) =>
  ps.reduce((a, p) => a + p.text.replace(/\s/g, '').length, 0);

// Optional OCR fallback for scanned/image-only PDFs. Uses tesseract.js if
// installed; silently skips if the dependency or poppler rendering is missing.
async function ocrPages(pdfPath: string, pageCount: number): Promise<PageContent[] | null> {
  let Tesseract: any;
  try {
    Tesseract = (await import('tesseract.js' as any)).default ?? (await import('tesseract.js' as any));
  } catch {
    logger.warn('OCR requested but tesseract.js is not installed; skipping OCR.');
    return null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  const pages: PageContent[] = [];
  const max = Math.min(pageCount, config.ocr.maxPages);
  for (let p = 1; p <= max; p++) {
    const img = renderPageImage(pdfPath, p, tmp, 150);
    if (!img) continue;
    try {
      const { data } = await Tesseract.recognize(img, config.ocr.langs);
      pages.push({ page: p, text: data.text || '', imageCount: 1 });
    } catch (e) {
      logger.warn(`OCR failed on page ${p}`, String(e));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return pages.length ? pages : null;
}

// Extract per-page text with a robust multi-backend strategy:
//   1) Poppler pdftotext (best layout)  ->  2) pdf.js (pure JS)  ->  3) OCR (optional)
export async function extractPages(pdfPath: string): Promise<PageContent[]> {
  let pages: PageContent[] | null = null;

  if (popplerAvailable()) {
    try {
      pages = extractWithPoppler(pdfPath);
      lastExtractionMethod = 'poppler';
    } catch (e) {
      logger.warn(`Poppler extraction failed, falling back to pdf.js: ${String(e)}`);
    }
  } else {
    logger.warn('Poppler not available; using pdf.js extractor.');
  }

  if (!pages || textLen(pages) < 5) {
    try {
      const alt = await extractPagesPdfjs(pdfPath);
      if (!pages || textLen(alt) > textLen(pages)) {
        pages = alt;
        lastExtractionMethod = 'pdfjs';
      }
    } catch (e) {
      logger.warn(`pdf.js extraction failed: ${String(e)}`);
    }
  }

  if (!pages) {
    throw new Error(
      'PDF text extraction failed: neither Poppler nor pdf.js could read this file.'
    );
  }

  // Scanned/image-only document: try OCR if enabled.
  if (textLen(pages) < 5 && config.ocr.enabled) {
    const ocr = await ocrPages(pdfPath, pages.length || getPageCount(pdfPath)).catch(() => null);
    if (ocr && textLen(ocr) > textLen(pages)) {
      pages = ocr;
      lastExtractionMethod = 'ocr';
    }
  }

  return pages;
}

export function renderPageImage(
  pdfPath: string,
  page: number,
  outDir: string,
  dpi: number
): string | null {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const prefix = path.join(outDir, `page-${page}`);
    run('pdftoppm', [
      '-png',
      '-r',
      String(dpi),
      '-f',
      String(page),
      '-l',
      String(page),
      '-singlefile',
      pdfPath,
      prefix,
    ]);
    const file = `${prefix}.png`;
    return fs.existsSync(file) ? file : null;
  } catch (e) {
    logger.warn(`pdftoppm failed for page ${page}`, String(e));
    return null;
  }
}
