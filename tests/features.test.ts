import { describe, it, expect } from 'vitest';
import {
  toWesternDigits,
  detectLanguage,
  isUnclearArabic,
  variantKey,
  stringSimilarity,
  parseTestNumber,
} from '../src/utils/lang.js';

describe('digit normalization (always Western)', () => {
  it('converts Arabic-Indic digits to Western', () => {
    expect(toWesternDigits('إذا كان عمر أحمد ١٥ سنة')).toBe('إذا كان عمر أحمد 15 سنة');
    expect(toWesternDigits('۲۰۲۶')).toBe('2026');
  });
  it('keeps Western digits and normalizes Arabic decimal/thousands', () => {
    expect(toWesternDigits('50%')).toBe('50%');
    expect(toWesternDigits('3\u066B14')).toBe('3.14');
  });
});

describe('language detection', () => {
  it('detects Arabic vs English', () => {
    expect(detectLanguage('ما هو ناتج جمع الأعداد')).toBe('ar');
    expect(detectLanguage('What is the sum of the numbers')).toBe('en');
  });
});

describe('unclear-Arabic detection (triggers English recovery)', () => {
  it('flags replacement chars and placeholder runs', () => {
    expect(isUnclearArabic('إذا كان العدد \uFFFD في المتتالية')).toBe(true);
    expect(isUnclearArabic('إذا كان العدد ____ في المتتالية')).toBe(true);
  });
  it('flags Arabic that references a number but has no digits', () => {
    expect(isUnclearArabic('إذا كان عمر أحمد يساوي كذا سنة فكم')).toBe(true);
  });
  it('does not flag clean Arabic with digits', () => {
    expect(isUnclearArabic('إذا كان عمر أحمد 15 سنة فكم عمره بعد 5 سنوات')).toBe(false);
  });
});

describe('source variant matching (generic, no hardcoded names)', () => {
  it('strips language tokens so AR/EN filenames share a key', () => {
    expect(variantKey('MyTests_arabic.pdf')).toBe(variantKey('MyTests_english.pdf'));
    expect(variantKey('IQ Set 3 (عربي).pdf')).toContain('iq set 3');
  });
  it('similarity is high for near-identical base names', () => {
    expect(stringSimilarity(variantKey('IQ Set 3 AR.pdf'), variantKey('IQ Set 3 EN.pdf'))).toBeGreaterThan(0.7);
  });
});

describe('safe source file resolution (path traversal)', () => {
  it('rejects traversal / unknown ids', async () => {
    const { resolveSourceFile } = await import('../src/services/library.js');
    expect(resolveSourceFile('../../etc/passwd')).toBeNull();
    expect(resolveSourceFile('..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveSourceFile('does-not-exist')).toBeNull();
  });
});

describe('test-number parsing (Arabic + English)', () => {
  it('parses English and Arabic test headings', () => {
    expect(parseTestNumber('Test 7 — Numerical')).toBe('7');
    expect(parseTestNumber('الاختبار 12')).toBe('12');
    expect(parseTestNumber('no number here')).toBeUndefined();
  });
});
