import path from 'node:path';
import os from 'node:os';
import { makeScannedSample } from './make-scanned-sample.js';
import { extractPages, lastExtractionMethod } from '../src/extraction/pdf.js';
import { parseDocument } from '../src/extraction/questions.js';
import { toWesternDigits } from '../src/utils/lang.js';

const out = path.join(os.tmpdir(), 'verify-scanned.pdf');
console.log('Generating scanned sample...');
await makeScannedSample(out);
console.log('Extracting (OCR pipeline)...');
const raw = await extractPages(out);
const pages = raw.map((p) => ({ ...p, text: toWesternDigits(p.text) }));
console.log('extractionMethod =', lastExtractionMethod);
console.log('pages =', pages.length);
for (const p of pages) {
  const preview = p.text.replace(/\s+/g, ' ').slice(0, 90);
  console.log(`  page ${p.page} ocr=${p.ocr ? 'Y' : 'N'} chars=${p.text.replace(/\s/g, '').length} :: ${preview}`);
}
const qs = parseDocument(pages);
console.log('QUESTIONS EXTRACTED =', qs.length);
for (const q of qs.slice(0, 8)) {
  console.log(`  Q${q.number}: ${q.questionText.slice(0, 60)} | choices=${(q.choices || []).length} | ans=${q.correctAnswer || '-'}`);
}
process.exit(0);
