import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fileSha256, stableUuid, uuid } from '../utils/hash.js';
import { contentHash } from '../utils/text.js';
import { extractPages, getPageCount, renderPageImage, lastExtractionMethod } from '../extraction/pdf.js';
import { parseDocument } from '../extraction/questions.js';
import { embedBatched, getEmbedder } from '../embeddings/index.js';
import {
  ensureCollection,
  upsertQuestions,
  deleteBySource,
  findNearDuplicate,
  countPoints,
} from '../vector/qdrant.js';
import { documents } from '../database/store.js';
import { detectLanguage, parseTestNumber } from '../utils/lang.js';
import { toWesternDigits } from '../utils/lang.js';
import { assignVariantGroup } from '../services/variants.js';
import type { DocumentRecord, QuestionRecord } from '../types.js';

export interface IngestResult {
  documentId: string;
  name: string;
  questions: number;
  passages: number;
  duplicatesSkipped: number;
  imagePages: number;
}

export function chunkText(text: string): string[] {
  const max = config.ingestion.chunkMaxChars;
  const overlap = config.ingestion.chunkOverlap;
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + max));
    i += max - overlap;
  }
  return chunks;
}

export async function ingestDocument(filePath: string): Promise<IngestResult> {
  const name = path.basename(filePath);
  const documentId = stableUuid(name);
  const fileHash = fileSha256(filePath);
  const now = new Date().toISOString();
  const sizeBytes = (() => {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  })();

  const setPhase = (phase: string, progress: number) => {
    const prev = documents.get(documentId);
    if (prev) documents.set(documentId, { ...prev, phase, progress, updatedAt: new Date().toISOString() });
  };

  const record: DocumentRecord = {
    id: documentId,
    name,
    fileHash,
    pages: 0,
    status: 'indexing',
    phase: 'Extracting text',
    progress: 5,
    questionCount: 0,
    passageCount: 0,
    imagePages: 0,
    tests: 0,
    language: 'other',
    linkedVariants: [],
    sizeBytes,
    categories: [],
    sections: [],
    updatedAt: now,
  };
  documents.set(documentId, record);

  try {
    const embedder = getEmbedder();
    await getEmbedderReady(embedder);
    await ensureCollection(embedder.dim);

    // Remove any previous vectors for this source (re-index safe).
    await deleteBySource(name);

    const rawPages = await extractPages(filePath);
    const extractionMethod = lastExtractionMethod;
    // Normalize Arabic-Indic digits to Western everywhere (policy: Western digits),
    // which also lets the numbered-question detector match Arabic numbering.
    const pages = config.language.westernDigits
      ? rawPages.map((p) => ({ ...p, text: toWesternDigits(p.text) }))
      : rawPages;
    record.pages = pages.length || getPageCount(filePath);

    setPhase('Detecting questions', 30);
    const parsed = parseDocument(pages);
    const questionPages = new Set(parsed.map((q) => q.page));

    // Document-level language from the extracted text.
    const docLanguage = detectLanguage(pages.map((p) => p.text).join(' ').slice(0, 20000));
    // Establish the variant group (links Arabic/English versions of a source).
    documents.set(documentId, { ...documents.get(documentId)!, language: docLanguage });
    const variantGroup = assignVariantGroup(documents.get(documentId)!);

    // Render page images for pages that contain images / visual questions.
    const imageDirForDoc = path.join(config.imagesDir, documentId);
    const pageImages = new Map<number, string[]>();
    let imagePages = 0;
    if (config.ingestion.renderPageImages) {
      const pagesWithImages = pages.filter(
        (p) => p.imageCount > 0 || parsed.some((q) => q.page === p.page && q.hasImage)
      );
      for (const p of pagesWithImages) {
        const out = renderPageImage(filePath, p.page, imageDirForDoc, config.ingestion.imageDpi);
        if (out) {
          pageImages.set(p.page, [`${documentId}/page-${p.page}.png`]);
          imagePages++;
        }
      }
    }

    // Build records: questions first, then passage fallback for pages w/o questions.
    const records: QuestionRecord[] = [];
    const sections = new Set<string>();
    const categories = new Set<string>();

    const tests = new Set<string>();

    for (const q of parsed) {
      if (q.section) sections.add(q.section);
      if (q.category) categories.add(q.category);
      const testNumber = parseTestNumber(q.section);
      if (testNumber) tests.add(testNumber);
      records.push({
        id: uuid(),
        type: 'question',
        source: name,
        documentId,
        page: q.page,
        section: q.section,
        number: q.number,
        questionText: q.questionText,
        choices: q.choices,
        correctAnswer: q.correctAnswer,
        answerSource: q.answerSource,
        explanation: q.explanation,
        explanationSource: q.explanationSource,
        category: q.category,
        categorySource: q.categorySource,
        difficulty: q.difficulty,
        difficultyEstimated: q.difficultyEstimated,
        hasImage: q.hasImage,
        requiresImage: q.requiresImage,
        imageRefs: pageImages.get(q.page) || [],
        language: detectLanguage(`${q.questionText} ${(q.choices || []).join(' ')}`),
        variantGroup,
        testNumber,
        confidence: 1,
        contentHash: contentHash(q.questionText),
        createdAt: now,
      });
    }

    let passages = 0;
    for (const p of pages) {
      if (questionPages.has(p.page)) continue;
      for (const chunk of chunkText(p.text)) {
        if (chunk.length < 40) continue;
        // Skip answer-key / solution grids so answers aren't exposed via search.
        const keyPairs = (chunk.match(/\b\d{1,3}\s*[.).:-]?\s*[A-Ea-e]\b/g) || []).length;
        if (keyPairs >= 6) continue;
        passages++;
        records.push({
          id: uuid(),
          type: 'passage',
          source: name,
          documentId,
          page: p.page,
          questionText: chunk,
          answerSource: 'none',
          explanationSource: 'none',
          categorySource: 'none',
          difficultyEstimated: false,
          hasImage: p.imageCount > 0,
          requiresImage: false,
          imageRefs: pageImages.get(p.page) || [],
          language: detectLanguage(chunk),
          variantGroup,
          confidence: 1,
          contentHash: contentHash(chunk),
          createdAt: now,
        });
      }
    }

    setPhase('Indexing (embeddings)', 60);
    // Embed all texts (batched).
    const texts = records.map((r) =>
      [r.section, r.questionText, (r.choices || []).join(' ')].filter(Boolean).join('\n')
    );
    const vectors = await embedBatched(texts);

    // Deduplication: exact (in-batch) + near-duplicate (cross-document via Qdrant).
    const seenHashes = new Set<string>();
    const preexisting = await countPoints({});
    const toUpsert: { vector: number[]; payload: QuestionRecord }[] = [];
    let duplicatesSkipped = 0;

    setPhase('Detecting duplicates', 75);
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (seenHashes.has(rec.contentHash)) {
        if (rec.type === 'question') duplicatesSkipped++;
        continue;
      }
      seenHashes.add(rec.contentHash);
      // Cross-document near-duplicate check is bounded and non-fatal: a transient
      // Qdrant hiccup must never abort ingestion of a large document.
      if (rec.type === 'question' && preexisting > 0 && i < 600) {
        try {
          const dup = await findNearDuplicate(vectors[i], 0.985);
          if (dup && dup.type === 'question') {
            duplicatesSkipped++;
            continue;
          }
        } catch (e) {
          logger.warn('near-duplicate check skipped (transient)', String(e));
        }
      }
      toUpsert.push({ vector: vectors[i], payload: rec });
    }

    setPhase('Indexing (upserting)', 85);
    // Upsert in modest chunks (large Arabic books can produce thousands of points).
    for (let i = 0; i < toUpsert.length; i += 128) {
      await upsertQuestions(toUpsert.slice(i, i + 128));
    }

    const qCount = toUpsert.filter((p) => p.payload.type === 'question').length;
    const pCount = toUpsert.filter((p) => p.payload.type === 'passage').length;

    const done: DocumentRecord = {
      ...record,
      status: 'ready',
      phase: 'Completed',
      progress: 100,
      questionCount: qCount,
      passageCount: pCount,
      imagePages,
      tests: tests.size,
      language: docLanguage,
      variantGroup,
      extractionMethod,
      linkedVariants: [],
      categories: [...categories].sort(),
      sections: [...sections].slice(0, 100),
      indexedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    documents.set(documentId, done);
    logger.info(
      `Indexed ${name}: ${qCount} questions, ${pCount} passages, ${imagePages} image pages, ${duplicatesSkipped} dups skipped`
    );
    return { documentId, name, questions: qCount, passages: pCount, duplicatesSkipped, imagePages };
  } catch (e) {
    logger.error(`Ingestion failed for ${name}`, String(e));
    documents.set(documentId, {
      ...record,
      status: 'error',
      error: String(e),
      updatedAt: new Date().toISOString(),
    });
    throw e;
  }
}

async function getEmbedderReady(embedder: { embed: (t: string[]) => Promise<number[][]> }) {
  // Trigger lazy model load so dim is known before ensureCollection.
  await embedder.embed(['warmup']);
}
