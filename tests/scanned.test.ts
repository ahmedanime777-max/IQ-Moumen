import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractPages, lastExtractionMethod } from '../src/extraction/pdf.js';
import { parseDocument } from '../src/extraction/questions.js';
import { toWesternDigits } from '../src/utils/lang.js';
import { makeScannedSample } from '../scripts/make-scanned-sample.js';

function have(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const OCR_READY = have('tesseract') && have('pdftoppm');

// ---- Scanned / CamScanner (image-only) PDF must produce questions, not 0 ----
describe('scanned / CamScanner PDF OCR', () => {
  let scanned: string;
  beforeAll(async () => {
    if (!OCR_READY) return;
    scanned = path.join(os.tmpdir(), `scan-test-${Date.now()}.pdf`);
    await makeScannedSample(scanned);
  }, 120000);

  it.skipIf(!OCR_READY)(
    'OCRs image-only pages (whose only text layer is a watermark) and extracts real questions',
    async () => {
      const raw = await extractPages(scanned);
      const pages = raw.map((p) => ({ ...p, text: toWesternDigits(p.text) }));
      // OCR must have kicked in for the scanned pages.
      expect(lastExtractionMethod).toMatch(/ocr/);
      expect(pages.some((p) => p.ocr)).toBe(true);
      // The watermark ("Noor-Book.com") must NOT be mistaken for real content;
      // OCR text should contain actual question content.
      expect(pages.some((p) => /discount|sequence|antonym|average speed/i.test(p.text))).toBe(true);

      const qs = parseDocument(pages);
      // THE KEY REGRESSION GUARD: a scanned PDF with recognizable questions must
      // NOT yield 0 questions just because the pages are images.
      expect(qs.length).toBeGreaterThan(0);
      const withChoices = qs.filter((q) => (q.choices || []).length >= 2);
      expect(withChoices.length).toBeGreaterThan(0);
    },
    180000
  );
});

// ---- Arabic question parsing (OCR output feeds the same parser) ----
describe('Arabic question parsing (numbers already Western-normalized)', () => {
  const arabicPages = [
    {
      page: 1,
      imageCount: 0,
      text: [
        'القسم 1 - تفكير عددي',
        'س1: ما هو ناتج جمع 2 و 3؟',
        'أ) 4',
        'ب) 5',
        'ج) 6',
        'د) 7',
        '2. إذا كان عمر أحمد 15 سنة، فكم يصبح عمره بعد 5 سنوات؟',
        'أ) 18',
        'ب) 19',
        'ج) 20',
        'د) 21',
      ].join('\n'),
    },
  ];

  const qs = parseDocument(arabicPages);

  it('does NOT discard pure-Arabic questions as noise', () => {
    expect(qs.length).toBe(2);
  });

  it('parses Arabic-letter choices (أ ب ج د)', () => {
    const q1 = qs.find((q) => q.number === '1')!;
    expect((q1.choices || []).length).toBe(4);
    expect(q1.questionText).toMatch(/ناتج جمع/);
  });

  it('keeps Western digits in Arabic questions', () => {
    const q2 = qs.find((q) => q.number === '2')!;
    expect(q2.questionText).toMatch(/15/);
    expect(q2.questionText).not.toMatch(/[٠-٩]/);
  });
});
