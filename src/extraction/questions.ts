import type { PageContent } from './pdf.js';
import { CATEGORIES, DIFFICULTIES } from '../config.js';
import { collapseWhitespace } from '../utils/text.js';

export interface ParsedQuestion {
  number?: string;
  page: number;
  section?: string;
  questionText: string;
  choices?: string[];
  correctAnswer?: string;
  answerSource: 'source' | 'none';
  explanation?: string;
  explanationSource: 'source' | 'none';
  category?: string;
  categorySource: 'source' | 'estimated' | 'none';
  difficulty?: string;
  difficultyEstimated: boolean;
  hasImage: boolean;
  requiresImage: boolean;
}

const IMAGE_CUES =
  /(figure|diagram|\bshapes?\b|shown below|shown above|which of the following figures?|series of figures?|the (matrix|grid) below|refer to the (figure|diagram|image)|complete the (pattern|matrix|grid)|\bnet of\b|mirror image|fold(ed|ing)?|rotat(e|ed|ion)|which figure|select the (figure|image|shape)|odd one out)/i;

const CATEGORY_KEYWORDS: Record<string, RegExp[]> = {
  Percentages: [/percent/i, /%/, /discount/i, /\bprofit\b/i, /\bloss\b/i, /interest rate/i],
  Ratios: [/\bratio\b/i, /proportion/i, /\bper\b/i],
  Sequences: [/\bseries\b/i, /sequence/i, /next (number|term|in)/i, /missing (number|term)/i],
  Analogies: [/analog/i, /\bis to\b/i, /::/, /relates to/i],
  Matrices: [/\bmatrix\b/i, /matrices/i, /\b3\s*[x×]\s*3\b/i, /grid of/i],
  'Spatial reasoning': [
    /\bcube\b/i,
    /\bfold(ed|ing)?\b/i,
    /rotat/i,
    /\bnet of\b/i,
    /mirror image/i,
    /three[- ]dimensional/i,
    /spatial/i,
  ],
  'Pattern recognition': [/\bpattern\b/i, /odd one out/i, /which figure/i, /figure series/i],
  'Verbal reasoning': [
    /antonym/i,
    /synonym/i,
    /vocabulary/i,
    /anagram/i,
    /\bspelling\b/i,
    /\bverbal\b/i,
    /which word/i,
  ],
  'Logical reasoning': [
    /syllogism/i,
    /\bconclusion/i,
    /\bstatements?\b/i,
    /\bdeduce\b/i,
    /\ball .* are\b/i,
    /if .* then/i,
    /logical/i,
  ],
  'Abstract reasoning': [/abstract/i, /\bsymbols?\b/i],
  'Critical thinking': [/assumption/i, /\bargument\b/i, /strengthens?/i, /weakens?/i, /inference/i],
  'Word problems': [
    /\btrain\b/i,
    /\bspeed\b/i,
    /distance/i,
    /\bage(s|d)?\b/i,
    /\bwork(er|ers)?\b/i,
    /fills? the tank/i,
    /cost of/i,
    /\bapples?\b/i,
  ],
  'Numerical reasoning': [
    /calculat/i,
    /\bsum\b/i,
    /average/i,
    /\bproduct\b/i,
    /multiply/i,
    /divide/i,
    /\barithmetic\b/i,
  ],
};

const CATEGORY_PRIORITY = [
  'Percentages',
  'Ratios',
  'Sequences',
  'Analogies',
  'Matrices',
  'Spatial reasoning',
  'Pattern recognition',
  'Critical thinking',
  'Word problems',
  'Verbal reasoning',
  'Logical reasoning',
  'Abstract reasoning',
  'Numerical reasoning',
];

export function classifyCategory(
  text: string,
  section?: string
): { category?: string; source: 'source' | 'estimated' | 'none' } {
  // Explicit section title that names a category => detected from source.
  if (section) {
    const s = section.toLowerCase();
    for (const cat of CATEGORIES) {
      if (cat !== 'Other' && s.includes(cat.toLowerCase())) return { category: cat, source: 'source' };
    }
  }
  const scores: Record<string, number> = {};
  for (const [cat, regs] of Object.entries(CATEGORY_KEYWORDS)) {
    let hits = 0;
    for (const r of regs) if (r.test(text)) hits++;
    if (hits > 0) scores[cat] = hits;
  }
  const best = CATEGORY_PRIORITY.filter((c) => scores[c]).sort((a, b) => scores[b] - scores[a])[0];
  if (best) return { category: best, source: 'estimated' };
  return { source: 'none' };
}

const DIFF_WORDS: Record<string, string> = {
  'very hard': 'Very Hard',
  'very difficult': 'Very Hard',
  expert: 'Very Hard',
  advanced: 'Hard',
  hard: 'Hard',
  difficult: 'Hard',
  challenging: 'Hard',
  medium: 'Medium',
  moderate: 'Medium',
  intermediate: 'Medium',
  easy: 'Easy',
  simple: 'Easy',
  basic: 'Easy',
  beginner: 'Easy',
};

export function estimateDifficulty(
  text: string,
  section?: string
): { difficulty: string; estimated: boolean } {
  const hay = `${section || ''} ${text}`.toLowerCase();
  for (const [word, level] of Object.entries(DIFF_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(hay)) return { difficulty: level, estimated: false };
  }
  const words = text.split(/\s+/).length;
  const digitGroups = (text.match(/\d+/g) || []).length;
  const bigNumber = /\d{4,}/.test(text);
  const multiStep = /(then|after|if\b|√|\^|equation|remainder|consecutive|average of|ratio of)/i.test(
    text
  );
  let score = 0;
  if (words > 60) score++;
  if (words > 120) score++;
  if (digitGroups >= 4) score++;
  if (bigNumber) score++;
  if (multiStep) score++;
  const level = DIFFICULTIES[Math.min(score, DIFFICULTIES.length - 1)];
  return { difficulty: level, estimated: true };
}

const SECTION_RE =
  /^\s*(chapter|section|test|part|unit|exercise|practice set)\s+([\dIVXLC]+|[A-Z])\b.*$/i;

function isNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return true;
  if (/\.{4,}\s*\d+\s*$/.test(t)) return true; // TOC dotted leader
  // Must contain some real letters — Latin OR Arabic (Arabic-only questions are
  // valid content and must NOT be discarded).
  if (!/[a-zA-Z\u0600-\u06FF]/.test(t)) return true;
  if (/^page\s+\d+/i.test(t)) return true;
  if (/copyright|all rights reserved|\bisbn\b/i.test(t) && t.length < 120) return true;
  return false;
}

// Detect an answer-key grid line and extract number->answer pairs.
function parseAnswerKeyLine(line: string): [number, string][] {
  const pairs: [number, string][] = [];
  const re = /\b(\d{1,3})\s*[.).:-]?\s*([A-Ea-e])\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) pairs.push([parseInt(m[1], 10), m[2].toUpperCase()]);
  return pairs;
}

function buildAnswerKey(pages: PageContent[]): Map<number, string> {
  const key = new Map<number, string>();
  for (const p of pages) {
    for (const line of p.text.split('\n')) {
      const pairs = parseAnswerKeyLine(line);
      if (pairs.length >= 2) for (const [n, a] of pairs) if (!key.has(n)) key.set(n, a);
    }
  }
  return key;
}

// Split a question block into stem + labelled choices. Supports Latin (A-E),
// Arabic (أ ب ج د هـ) and enclosed variants like "(A)" / "(أ)".
function findChoiceRun(
  block: string,
  markerRe: RegExp,
  alphabet: string[],
  normalize: (l: string) => string
): { stem: string; choices?: string[] } | null {
  const markers: { letter: string; index: number; matchLen: number }[] = [];
  let m: RegExpExecArray | null;
  markerRe.lastIndex = 0;
  while ((m = markerRe.exec(block))) {
    markers.push({ letter: normalize(m[1]), index: m.index, matchLen: m[0].length });
  }
  const first = alphabet[0];
  const start = markers.findIndex((x) => x.letter === first);
  if (start === -1 || markers.length - start < 2) return null;
  const run = markers.slice(start);
  const stem = collapseWhitespace(block.slice(0, run[0].index));
  const choices: string[] = [];
  for (let i = 0; i < run.length; i++) {
    const from = run[i].index + run[i].matchLen;
    const to = i + 1 < run.length ? run[i + 1].index : block.length;
    const val = collapseWhitespace(block.slice(from, to));
    if (val) choices.push(`${run[i].letter}) ${val}`);
  }
  if (choices.length < 2) return null;
  return { stem, choices };
}

// Normalize Arabic alef/hamza variants so أ/إ/آ/ا all match the first choice.
const normAr = (l: string) => (/[أإآا]/.test(l) ? 'ا' : l.replace(/ـ$/, ''));

function extractChoices(block: string): { stem: string; choices?: string[] } {
  // 1) Latin A-E markers ("A)" "a." "(B)")
  const latin = findChoiceRun(
    block,
    /(?:^|\s)\(?([A-Ea-e])[).\-]\s+/g,
    ['A', 'B', 'C', 'D', 'E'],
    (l) => l.toUpperCase()
  );
  if (latin) return latin;

  // 2) Arabic letter markers ("أ)" "ب-" "(ج)")
  const arabic = findChoiceRun(
    block,
    /(?:^|\s)\(?([أإآا]|ب|ج|د|هـ|ه)\s*[).\-]\s+/g,
    ['ا', 'ب', 'ج', 'د', 'ه'],
    normAr
  );
  if (arabic) return arabic;

  return { stem: collapseWhitespace(block) };
}

function extractInlineAnswer(block: string): string | undefined {
  const m = block.match(
    /(?:correct answer|correct option|answer|ans)\s*[:\-–]?\s*\(?([A-Ea-e]\b|\d[\d.,/ ]{0,20})/i
  );
  return m ? m[1].trim() : undefined;
}

function extractExplanation(block: string): string | undefined {
  const m = block.match(/(?:explanation|solution|reason(?:ing)?)\s*[:\-–]\s*([\s\S]+)$/i);
  if (!m) return undefined;
  const exp = collapseWhitespace(m[1]);
  return exp.length > 5 ? exp : undefined;
}

const QSTART_RE = /^\s*(?:Q(?:uestion)?\.?\s*|Problem\s+|السؤال\s*|سؤال\s*|س\s*|\()?(\d{1,3})\s*[.)\]:\-]\s+(\S.*)$/;

export function parseDocument(pages: PageContent[]): ParsedQuestion[] {
  const answerKey = buildAnswerKey(pages);
  const results: ParsedQuestion[] = [];
  let currentSection: string | undefined;

  // Per-page visual flags (image count or visual cue in the page text).
  const pageHasImageMap = new Map<number, boolean>();
  for (const p of pages) pageHasImageMap.set(p.page, p.imageCount > 0 || IMAGE_CUES.test(p.text));

  // Block state is carried ACROSS pages so questions that span a page break
  // keep their choices/answer. Each question is attributed to its start page.
  let block: string[] = [];
  let blockNumber: string | undefined;
  let startPage = 1;
  let pageHasImage = false;

  const flush = () => {
    if (!blockNumber || block.length === 0) {
      block = [];
      return;
    }
    const rawBlock = block.join('\n');
    block = [];
    if (isNoise(rawBlock)) return;

    const { stem, choices } = extractChoices(rawBlock);
    const explanation = extractExplanation(rawBlock);
    let stemText = stem;
    // Trim answer/explanation tails from the stem.
    stemText = stemText
      .replace(/(?:explanation|solution|reason(?:ing)?)\s*[:\-–][\s\S]*$/i, '')
      .replace(/(?:correct answer|correct option|answer|ans)\s*[:\-–]?\s*\(?[A-Ea-e0-9][\s\S]*$/i, '')
      .trim();
    if (isNoise(stemText)) return;

    const inlineAns = extractInlineAnswer(rawBlock);
    const keyAns = blockNumber ? answerKey.get(parseInt(blockNumber, 10)) : undefined;
    const correctAnswer = inlineAns || keyAns;

    const cat = classifyCategory(`${stemText} ${(choices || []).join(' ')}`, currentSection);
    const diff = estimateDifficulty(stemText, currentSection);

    const requiresImage =
      pageHasImage &&
      (stemText.length < 40 ||
        /which figure|figure that|complete the (pattern|matrix|grid)|odd one out|select the (figure|image|shape)|the (matrix|grid) below/i.test(
          stemText
        ) ||
        (choices ? choices.every((c) => c.replace(/^[A-E]\)\s*/, '').length <= 3) : false));

    results.push({
      number: blockNumber,
      page: startPage,
      section: currentSection,
      questionText: stemText,
      choices,
      correctAnswer,
      answerSource: correctAnswer ? 'source' : 'none',
      explanation,
      explanationSource: explanation ? 'source' : 'none',
      category: cat.category,
      categorySource: cat.source,
      difficulty: diff.difficulty,
      difficultyEstimated: diff.estimated,
      hasImage: pageHasImage,
      requiresImage,
    });
  };

  for (const page of pages) {
    const lines = page.text.split('\n');
    for (const line of lines) {
      const sec = line.match(SECTION_RE);
      if (sec) {
        flush();
        blockNumber = undefined;
        currentSection = collapseWhitespace(line);
        continue;
      }
      // Ignore answer-key grid lines (e.g. "1. B  2. C  3. A") during question parsing.
      if (parseAnswerKeyLine(line).length >= 2) continue;

      const qs = line.match(QSTART_RE);
      if (qs) {
        flush();
        blockNumber = qs[1];
        block = [qs[2]];
        startPage = page.page;
        pageHasImage = pageHasImageMap.get(page.page) || false;
      } else if (blockNumber) {
        block.push(line);
      }
    }
  }
  flush();

  return results;
}
