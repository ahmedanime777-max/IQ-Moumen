import fs from 'node:fs';
import { logger } from '../utils/logger.js';
import type { PageContent } from './pdf.js';

// Pure-JS PDF text extraction fallback (no external Poppler binary required).
// Reconstructs per-page text from pdf.js text items and counts embedded images.
export async function extractPagesPdfjs(filePath: string): Promise<PageContent[]> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const imageOps = new Set<number>(
    [
      pdfjs.OPS?.paintImageXObject,
      pdfjs.OPS?.paintJpegXObject,
      pdfjs.OPS?.paintInlineImage,
      pdfjs.OPS?.paintImageMaskXObject,
    ].filter((x: unknown) => x !== undefined)
  );

  const pages: PageContent[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    // Group text items into lines by their (rounded) y coordinate.
    const lines = new Map<number, { x: number; str: string }[]>();
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string') continue;
      const x = it.transform[4];
      const y = Math.round(it.transform[5]);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y)!.push({ x, str: it.str });
    }
    const orderedY = [...lines.keys()].sort((a, b) => b - a); // top -> bottom
    const text = orderedY
      .map((y) =>
        lines
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((t) => t.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .join('\n');

    let imageCount = 0;
    try {
      const opList = await page.getOperatorList();
      for (const fn of opList.fnArray as number[]) if (imageOps.has(fn)) imageCount++;
    } catch {
      /* ignore operator list errors */
    }
    pages.push({ page: i, text, imageCount });
  }
  logger.info(`pdf.js fallback extracted ${pages.length} pages from ${filePath}`);
  return pages;
}
