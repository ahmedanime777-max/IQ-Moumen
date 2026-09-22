// Language + digit helpers for the Arabic-first presentation policy.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

// Convert any Arabic-Indic / Eastern-Arabic-Indic digits to Western 0-9.
// Also normalizes the Arabic decimal separator (U+066B) and thousands (U+066C).
export function toWesternDigits(input: string | undefined | null): string {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    const ai = ARABIC_INDIC.indexOf(ch);
    if (ai >= 0) {
      out += String(ai);
      continue;
    }
    const ei = EASTERN_ARABIC_INDIC.indexOf(ch);
    if (ei >= 0) {
      out += String(ei);
      continue;
    }
    if (ch === '\u066B') out += '.';
    else if (ch === '\u066C') out += ',';
    else out += ch;
  }
  return out;
}

export function countArabic(s: string): number {
  return (s.match(/[\u0600-\u06FF]/g) || []).length;
}
export function countLatin(s: string): number {
  return (s.match(/[A-Za-z]/g) || []).length;
}

export function detectLanguage(s: string): 'ar' | 'en' | 'other' {
  const ar = countArabic(s);
  const la = countLatin(s);
  if (ar === 0 && la === 0) return 'other';
  if (ar >= la) return 'ar';
  return 'en';
}

// Heuristic: does an Arabic string look corrupted / unclear (broken OCR,
// missing numbers/symbols, replacement chars, placeholder runs)?
export function isUnclearArabic(s: string): boolean {
  if (!s) return true;
  if (/\uFFFD/.test(s)) return true; // replacement character
  const ar = countArabic(s);
  if (ar < 3) return false; // not really Arabic; handled elsewhere
  // Placeholder runs where a value likely went missing.
  if (/(\?{1,}|؟{1,}\s*[^\u0600-\u06FF]|_{2,}|\.{4,}|[□■◻◼]{1,}|x{3,})/i.test(s)) return true;
  // Mentions a numeric relationship but has no digits at all.
  const mentionsNumber =
    /(عدد|رقم|قيمة|نسبة|يساوي|مجموع|ناتج|كم|سنة|سنوات|عمر|متوسط)/.test(s) &&
    !/[0-9٠-٩۰-۹]/.test(s);
  if (mentionsNumber) return true;
  return false;
}

// Dice coefficient on character bigrams (0..1).
export function stringSimilarity(a: string, b: string): number {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
  const s1 = norm(a);
  const s2 = norm(b);
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const bg = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const m1 = bg(s1);
  const m2 = bg(s2);
  let inter = 0;
  for (const [g, c] of m1) inter += Math.min(c, m2.get(g) || 0);
  return (2 * inter) / (s1.length - 1 + (s2.length - 1));
}

const LANG_TOKENS =
  /(arabic|english|عربي|عربى|العربية|انجليزي|إنجليزي|الانجليزية|الإنجليزية|_ar\b|_en\b|-ar\b|-en\b|\bar\b|\ben\b|version|نسخة|translated|ترجمة)/gi;

// Strip language/version tokens + extension to get a comparable "variant key".
export function variantKey(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(LANG_TOKENS, ' ')
    .replace(/[^a-z0-9\u0600-\u06FF]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Parse a test/section number from a section heading (Arabic or English).
export function parseTestNumber(section?: string): string | undefined {
  if (!section) return undefined;
  const m = section.match(/(?:test|part|section|unit|اختبار|القسم|الجزء|الاختبار)\s*[:#-]?\s*(\d{1,3})/i);
  return m ? m[1] : undefined;
}
