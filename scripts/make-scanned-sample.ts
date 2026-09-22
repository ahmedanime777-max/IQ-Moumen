import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';

// Generates a GENERIC "scanned" aptitude PDF that mimics a CamScanner / Noor-Book
// export: the pages are IMAGES of questions (no real text layer) and the only
// text layer is a "Noor-Book.com" watermark. This is exactly the case that used
// to yield "0 questions"; with the per-page OCR fix it must now extract them.
//
// Output: <SOURCES_DIR>/sample-scanned-test.pdf
export async function makeScannedSample(outPath?: string): Promise<string> {
  const out = outPath || path.join(config.sourcesDir, 'sample-scanned-test.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));

  // 1) Build a normal content PDF (this becomes the "paper" that gets scanned).
  const srcPdf = path.join(tmp, 'content.pdf');
  await buildContentPdf(srcPdf);

  // 2) Rasterize each page to a PNG (simulating a scan — loses the text layer).
  execFileSync('pdftoppm', ['-png', '-r', '150', srcPdf, path.join(tmp, 'page')]);
  const pngs = fs
    .readdirSync(tmp)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(tmp, f));

  // 3) Rebuild an IMAGE-ONLY PDF, adding only a sparse "Noor-Book.com" watermark
  //    as the text layer (so pdftotext returns junk, forcing OCR).
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);
  const W = 595.28;
  const H = 841.89;
  pngs.forEach((png, i) => {
    if (i > 0) doc.addPage({ size: 'A4', margin: 0 });
    doc.image(png, 0, 0, { width: W, height: H });
    // Watermark-only text layer (the useless "extracted text" of a scan).
    doc.fontSize(7).fillColor('#dddddd').text('Noor-Book.com', 20, H - 24);
  });
  doc.end();
  await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
  return out;
}

function buildContentPdf(file: string): Promise<void> {
  const doc = new PDFDocument({ size: 'A4', margin: 54 });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);
  const SEC = (t: string) =>
    doc.moveDown(0.5).fontSize(15).fillColor('#111').text(t).moveDown(0.2);
  const Q = (t: string) => doc.fontSize(12).fillColor('#111').text(t, { lineGap: 2 }).moveDown(0.1);
  const C = (t: string) => doc.fontSize(12).text('   ' + t).moveDown(0.03);

  doc.fontSize(18).text('Aptitude Practice Set (Scanned)', { align: 'center' }).moveDown(0.5);
  SEC('Section 1 - Numerical Reasoning');
  Q('1. A shirt priced at 80 is sold at a 25% discount. What is the discounted price?');
  C('A) 55'); C('B) 60'); C('C) 65'); C('D) 70');
  Q('2. A train travels 240 km in 3 hours. What is its average speed in km/h?');
  C('A) 60'); C('B) 70'); C('C) 80'); C('D) 90');
  Q('3. Find the next number in the sequence: 2, 6, 12, 20, 30, ?');
  C('A) 36'); C('B) 40'); C('C) 42'); C('D) 44');

  doc.addPage();
  SEC('Section 2 - Verbal Reasoning');
  Q('4. Choose the word that is the antonym of abundant.');
  C('A) plentiful'); C('B) scarce'); C('C) generous'); C('D) ample');
  Q('5. Book is to Reading as Fork is to ?');
  C('A) Drawing'); C('B) Writing'); C('C) Eating'); C('D) Stirring');
  Q('6. What is 15 percent of 200?');
  C('A) 20'); C('B) 25'); C('C) 30'); C('D) 45');

  doc.end();
  return new Promise((resolve) => stream.on('finish', () => resolve()));
}

// Allow running directly: `tsx scripts/make-scanned-sample.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  makeScannedSample()
    .then((p) => {
      console.log(`Scanned sample written to ${p}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
