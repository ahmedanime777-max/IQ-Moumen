import { documents } from '../database/store.js';
import { variantKey, stringSimilarity } from '../utils/lang.js';
import { uuid } from '../utils/hash.js';
import { scrollRecords } from '../vector/qdrant.js';
import { getEmbedder } from '../embeddings/index.js';
import { searchQuestions } from '../vector/qdrant.js';
import type { DocumentRecord, QuestionRecord } from '../types.js';

// Decide the variant group for a freshly-ingested document by comparing it to
// existing documents (filename similarity + page-count closeness + language
// difference). Generic — no hardcoded book/author/test names.
export function assignVariantGroup(doc: DocumentRecord): string {
  const key = variantKey(doc.name);
  const others = documents.all().filter((d) => d.id !== doc.id && d.status !== 'error');
  for (const o of others) {
    const sim = stringSimilarity(key, variantKey(o.name));
    const pageClose =
      doc.pages > 0 &&
      o.pages > 0 &&
      Math.abs(doc.pages - o.pages) / Math.max(doc.pages, o.pages) <= 0.3;
    const diffLang = !!o.language && !!doc.language && o.language !== doc.language;
    const match =
      sim >= 0.6 || (sim >= 0.35 && pageClose) || (pageClose && diffLang && sim >= 0.25);
    if (match) {
      const groupId = o.variantGroup || uuid();
      if (!o.variantGroup) documents.set(o.id, { ...o, variantGroup: groupId });
      return groupId;
    }
  }
  return doc.variantGroup || uuid();
}

export function linkedVariantNames(doc: DocumentRecord): string[] {
  if (!doc.variantGroup) return [];
  return documents
    .all()
    .filter((d) => d.id !== doc.id && d.variantGroup === doc.variantGroup)
    .map((d) => d.name);
}

// Find the corresponding English question for an unclear Arabic one.
// Structural matching (test number + question number) is language-agnostic and
// reliable; a weak semantic fallback is used only with low confidence.
export async function findEnglishCounterpart(
  arRec: QuestionRecord
): Promise<{ rec: QuestionRecord; confidence: number } | null> {
  if (!arRec.variantGroup) return null;
  const englishDocs = documents
    .all()
    .filter((d) => d.variantGroup === arRec.variantGroup && d.language === 'en');
  if (!englishDocs.length) return null;

  for (const doc of englishDocs) {
    const { records } = await scrollRecords({ source: doc.name, type: 'question' }, 4000);
    // 1) Exact structural match on question number (+ test number when present).
    const byNumber = records.filter(
      (r) =>
        r.number &&
        arRec.number &&
        r.number === arRec.number &&
        (!(r.testNumber && arRec.testNumber) || r.testNumber === arRec.testNumber)
    );
    if (byNumber.length === 1) return { rec: byNumber[0], confidence: 0.95 };
    if (byNumber.length > 1) {
      // Disambiguate multiple same-numbered questions by choice-count similarity.
      const best = byNumber.sort(
        (a, b) =>
          Math.abs((a.choices?.length || 0) - (arRec.choices?.length || 0)) -
          Math.abs((b.choices?.length || 0) - (arRec.choices?.length || 0))
      )[0];
      return { rec: best, confidence: 0.8 };
    }
  }

  // 2) Weak semantic fallback (cross-lingual similarity is unreliable -> low confidence).
  try {
    const vec = await getEmbedder().embedOne(arRec.questionText);
    for (const doc of englishDocs) {
      const hits = await searchQuestions(vec, { limit: 1, source: doc.name, type: 'question' });
      if (hits.length && (hits[0].score ?? 0) >= 0.55) {
        return { rec: hits[0].payload, confidence: Math.min(0.6, hits[0].score) };
      }
    }
  } catch {
    /* embedding unavailable */
  }
  return null;
}
