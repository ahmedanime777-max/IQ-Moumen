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
  ocr?: boolean;
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

// ---- Watermark / scan-noise filtering ----
// Text that must NOT count as "real" extracted content (typical of scanned PDFs).
const NOISE_RE =
  /noor[-\s]?book(\.com)?|كتب\s*نور|scanned\s*by\s*camscanner|camscanner|https?:\/\/\S+|www\.\S+|©|copyright/gi;

function meaningfulChars(t: string): number {
  const cleaned = (t || '').replace(NOISE_RE, ' ');
  return (cleaned.match(/[A-Za-z\u0600-\u06FF0-9]/g) || []).length;
}

// A page's PDF text layer is "useful" only if it has enough real (non-watermark)
// letters/digits. Watermark-only or empty pages (typical of CamScanner scans)
// return false so they get routed through OCR instead of being trusted as text.
function isPageTextUseful(text: string): boolean {
  return meaningfulChars(text) >= config.ocr.minUsefulChars;
}

function tesseractAvailable(): boolean {
  try {
    run('tesseract', ['--version']);
    return true;
  } catch {
    return false;
  }
}

// Render a page to a grayscale PNG at OCR DPI (higher DPI + grayscale improves
// accuracy on noisy CamScanner scans) and OCR it with the configured languages.
function ocrRenderedPage(pdfPath: string, page: number, tmpDir: string): string {
  const img = renderPageImage(pdfPath, page, tmpDir, config.ocr.dpi, true);
  if (!img) return '';
  try {
    // --oem 1 = LSTM engine; --psm 3 = automatic page segmentation so that
    // multiple questions on one page are all captured. Leptonica (bundled with
    // tesseract) handles binarization/deskew of the noisy scan internally.
    return run('tesseract', [img, 'stdout', '-l', config.ocr.langs, '--oem', '1', '--psm', '3']);
  } catch (e) {
    logger.warn(`OCR failed on page ${page}`, String(e));
    return '';
  }
}

// Per-page OCR: replace the text of every page whose PDF text layer is NOT
// useful (scanned / watermark-only) with OCR output. This covers image-only
// PDFs and mixed PDFs (some real-text pages, some scanned) alike.
async function ocrEnhancePages(pdfPath: string, pages: PageContent[]): Promise<PageContent[]> {
  if (!tesseractAvailable()) {
    logger.warn('OCR requested but the tesseract binary is not installed; skipping OCR.');
    return pages;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
  let ocrCount = 0;
  try {
    const limit = Math.min(pages.length, config.ocr.maxPages);
    for (let i = 0; i < limit; i++) {
      const p = pages[i];
      if (isPageTextUseful(p.text)) continue; // real text layer -> keep as-is
      const text = ocrRenderedPage(pdfPath, p.page, tmp);
      if (meaningfulChars(text) > meaningfulChars(p.text)) {
        pages[i] = { page: p.page, text, imageCount: Math.max(1, p.imageCount), ocr: true };
        ocrCount++;
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (ocrCount > 0) {
    lastExtractionMethod = lastExtractionMethod === 'none' ? 'ocr' : `${lastExtractionMethod}+ocr`;
    logger.info(`OCR extracted text from ${ocrCount} scanned page(s) using '${config.ocr.langs}'.`);
  }
  return pages;
}

// Extract per-page text with a robust multi-backend strategy:
//   1) Poppler pdftotext (best layout)  ->  2) pdf.js (pure JS)
//   3) Per-page OCR for any scanned/watermark-only pages (Arabic + English)
export async function extractPages(pdfPath: string): Promise<PageContent[]> {
  let pages: PageContent[] | null = null;
  lastExtractionMethod = 'none';

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

  // If both text extractors returned nothing, still build an empty per-page
  // skeleton from the page count so OCR can run on a fully image-only PDF.
  if (!pages || pages.length === 0) {
    const count = getPageCount(pdfPath);
    if (count > 0) {
      pages = Array.from({ length: count }, (_, i) => ({ page: i + 1, text: '', imageCount: 1 }));
      if (lastExtractionMethod === 'none') lastExtractionMethod = 'ocr';
    }
  }

  if (!pages) {
    throw new Error(
      'PDF text extraction failed: neither Poppler nor pdf.js could read this file.'
    );
  }

  // Scanned/image-only OR mixed document: OCR every page whose text layer is
  // not useful (empty, sparse, or watermark-only). THIS IS THE KEY FIX so that
  // CamScanner-style image PDFs yield real questions instead of "0 questions".
  if (config.ocr.enabled) {
    const needsOcr = pages.some((p) => !isPageTextUseful(p.text));
    if (needsOcr) {
      pages = await ocrEnhancePages(pdfPath, pages);
    }
  }

  return pages;
}

export function renderPageImage(
  pdfPath: string,
  page: number,
  outDir: string,
  dpi: number,
  gray = false
): string | null {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const prefix = path.join(outDir, `page-${page}`);
    const args = ['-png'];
    if (gray) args.push('-gray');
    args.push(
      '-r',
      String(dpi),
      '-f',
      String(page),
      '-l',
      String(page),
      '-singlefile',
      pdfPath,
      prefix
    );
    run('pdftoppm', args);
    const file = `${prefix}.png`;
    return fs.existsSync(file) ? file : null;
  } catch (e) {
    logger.warn(`pdftoppm failed for page ${page}`, String(e));
    return null;
  }
}
