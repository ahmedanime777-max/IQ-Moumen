import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface PageContent {
  page: number;
  text: string;
  imageCount: number;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { maxBuffer: 1024 * 1024 * 200 }).toString('utf8');
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

// Count embedded raster images per page using `pdfimages -list`.
function imageCountsByPage(pdfPath: string): Map<number, number> {
  const counts = new Map<number, number>();
  try {
    const out = run('pdfimages', ['-list', pdfPath]);
    const lines = out.split('\n').slice(2); // skip header rows
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

// Extract per-page text (poppler inserts form-feed \f between pages).
export function extractPages(pdfPath: string): PageContent[] {
  let raw = '';
  try {
    raw = run('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-']);
  } catch (e) {
    logger.error(`pdftotext failed for ${pdfPath}`, String(e));
    throw new Error('PDF text extraction failed (poppler pdftotext required).');
  }
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

// Render a single page to PNG. Returns the file path (relative names handled by caller).
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
