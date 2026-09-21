import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, classifyCategory, estimateDifficulty } from '../src/extraction/questions.js';
import { chunkText } from '../src/ingestion/pipeline.js';
import { compareAnswer } from '../src/services/library.js';
import { contentHash, normalizeForHash, cosine } from '../src/utils/text.js';
import { extractPages, getPageCount } from '../src/extraction/pdf.js';
import { config } from '../src/config.js';

const page = (n: number, text: string, imageCount = 0) => ({ page: n, text, imageCount });

describe('question extraction', () => {
  const pages = [
    page(
      1,
      [
        'Section 1 — Numerical Reasoning',
        '1. A shirt priced at 80 is sold at a 25% discount. What is the discounted price?',
        ' A) 55',
        ' B) 60',
        ' C) 65',
        ' D) 70',
        '2. Find the next number in the sequence: 2, 6, 12, 20, ? (Difficulty: Hard)',
        ' A) 28',
        ' B) 30',
        ' C) 32',
        ' D) 42',
      ].join('\n')
    ),
    page(2, ['Answer Key', '1. B   2. D'].join('\n')),
  ];

  const qs = parseDocument(pages);

  it('extracts the right number of questions and ignores the answer key grid', () => {
    expect(qs.length).toBe(2);
  });

  it('parses labelled choices', () => {
    const q1 = qs.find((q) => q.number === '1')!;
    expect(q1.choices).toEqual(['A) 55', 'B) 60', 'C) 65', 'D) 70']);
    expect(q1.questionText).toMatch(/discounted price/);
  });

  it('attaches answers from the answer key', () => {
    expect(qs.find((q) => q.number === '1')!.correctAnswer).toBe('B');
    expect(qs.find((q) => q.number === '2')!.correctAnswer).toBe('D');
  });

  it('preserves source-provided difficulty (not estimated)', () => {
    const q2 = qs.find((q) => q.number === '2')!;
    expect(q2.difficulty).toBe('Hard');
    expect(q2.difficultyEstimated).toBe(false);
  });

  it('detects a figure-based question and marks requiresImage', () => {
    const imgPages = [
      page(
        1,
        ['5. Which figure is the odd one out among the shapes shown below?', ' A) 1', ' B) 2'].join(
          '\n'
        ),
        2
      ),
    ];
    const parsed = parseDocument(imgPages);
    expect(parsed[0].hasImage).toBe(true);
    expect(parsed[0].requiresImage).toBe(true);
  });

  it('carries a question that spans a page break', () => {
    const split = [
      page(1, ['1. Book is to Reading as Fork is to ?', ' A) Drawing'].join('\n')),
      page(2, [' B) Writing', ' C) Eating', ' D) Stirring'].join('\n')),
    ];
    const parsed = parseDocument(split);
    expect(parsed.length).toBe(1);
    expect(parsed[0].choices).toEqual(['A) Drawing', 'B) Writing', 'C) Eating', 'D) Stirring']);
    expect(parsed[0].page).toBe(1);
  });
});

describe('classification', () => {
  it('classifies percentages and ratios from keywords (estimated)', () => {
    expect(classifyCategory('What is 20% of 150?').category).toBe('Percentages');
    expect(classifyCategory('The ratio of a to b is 3:2').category).toBe('Ratios');
    expect(classifyCategory('What is 20% of 150?').source).toBe('estimated');
  });

  it('treats a category-named section as source-detected', () => {
    const r = classifyCategory('some text', 'Section 2 — Verbal reasoning');
    expect(r.category).toBe('Verbal reasoning');
    expect(r.source).toBe('source');
  });

  it('does not force a category when uncertain', () => {
    expect(classifyCategory('hello there friend').category).toBeUndefined();
  });
});

describe('difficulty', () => {
  it('uses explicit difficulty words', () => {
    expect(estimateDifficulty('a very hard question').estimated).toBe(false);
    expect(estimateDifficulty('a very hard question').difficulty).toBe('Very Hard');
  });
  it('estimates difficulty for plain short questions', () => {
    const r = estimateDifficulty('What is 2 + 2?');
    expect(r.estimated).toBe(true);
    expect(['Easy', 'Medium', 'Hard', 'Very Hard']).toContain(r.difficulty);
  });
});

describe('chunking', () => {
  it('splits long text into overlapping chunks', () => {
    const long = 'x'.repeat(config.ingestion.chunkMaxChars * 3);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].length).toBeLessThanOrEqual(config.ingestion.chunkMaxChars);
  });
  it('keeps short text as a single chunk', () => {
    expect(chunkText('short text').length).toBe(1);
  });
});

describe('answer checking', () => {
  const choices = ['A) 55', 'B) 60', 'C) 65', 'D) 70'];
  it('matches identical answers', () => expect(compareAnswer('B', 'B')).toBe(true));
  it('maps a typed option text to the correct letter', () =>
    expect(compareAnswer('60', 'B', choices)).toBe(true));
  it('maps a letter to the option text', () =>
    expect(compareAnswer('B', '60', choices)).toBe(true));
  it('compares numerically', () => expect(compareAnswer('42', '42.0')).toBe(true));
  it('rejects wrong answers', () => expect(compareAnswer('A', 'B', choices)).toBe(false));
});

describe('dedupe + vector utils', () => {
  it('produces identical hashes for normalized duplicates', () => {
    expect(contentHash('Hello,  World!')).toBe(contentHash('hello world'));
    expect(normalizeForHash('A-B_C')).toBe('a b c');
  });
  it('cosine of identical vectors is ~1', () => {
    expect(cosine([1, 0, 1], [1, 0, 1])).toBeCloseTo(1, 5);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
});

describe('pdf extraction (requires poppler + sample PDF)', () => {
  const sample = path.join(config.sourcesDir, 'sample-aptitude-test.pdf');
  it.skipIf(!fs.existsSync(sample))('extracts pages and preserves page numbers', () => {
    const pages = extractPages(sample);
    expect(getPageCount(sample)).toBeGreaterThan(0);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0].page).toBe(1);
    expect(pages.some((p) => /discount|sequence|matrix|ratio/i.test(p.text))).toBe(true);
  });
});
