import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { llmComplete, llmEnabled } from '../llm/index.js';
import { getEmbedder } from '../embeddings/index.js';
import {
  searchQuestions,
  getById,
  scrollIds,
  scrollRecords,
  countPoints,
  setPayload,
} from '../vector/qdrant.js';
import { documents } from '../database/store.js';
import { shuffle, pick } from '../utils/text.js';
import { toWesternDigits, isUnclearArabic } from '../utils/lang.js';
import { findEnglishCounterpart } from './variants.js';
import type { QuestionRecord } from '../types.js';

export function imageUrl(ref: string): string {
  const base = config.publicBaseUrl || '';
  return `${base}/rest/images/${ref}`;
}

const W = (s: string | undefined | null) =>
  config.language.westernDigits ? toWesternDigits(s || '') : s || '';

// Translate a question (stem + choices) to Modern Standard Arabic while keeping
// all numbers/symbols in Western digits. Returns null if no LLM is available.
async function translateToArabic(
  text: string,
  choices?: string[]
): Promise<{ text: string; choices?: string[] } | null> {
  if (!llmEnabled()) return null;
  const payload = JSON.stringify({ text, choices: choices ?? [] });
  const out = await llmComplete(
    'You are a precise translator for an aptitude test. Translate the given question into Modern Standard Arabic. RULES: keep every number, equation and mathematical symbol EXACTLY as-is using Western digits (0-9, never Arabic-Indic). Preserve choice letters like "A)". Do not solve or add commentary. Respond with ONLY valid JSON: {"text": "...", "choices": ["A) ...", ...]}.',
    `Translate this to Arabic and return JSON only:\n${payload}`
  );
  if (!out) return null;
  try {
    const jsonStart = out.indexOf('{');
    const jsonEnd = out.lastIndexOf('}');
    const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));
    return {
      text: W(parsed.text),
      choices: Array.isArray(parsed.choices) && parsed.choices.length ? parsed.choices.map(W) : undefined,
    };
  } catch {
    return null;
  }
}

export interface PresentResult {
  displayLanguage: string;
  originalLanguage: string;
  questionText: string;
  choices: string[] | null;
  recovery: { used: boolean; from?: string; confidence?: number; note?: string } | null;
}

// Arabic-first presentation of a question, with English-variant recovery when
// the Arabic text is unclear/corrupted. Caches translations back into Qdrant.
async function presentText(rec: QuestionRecord): Promise<PresentResult> {
  const target = config.language.present; // 'ar' by default
  const recovery: PresentResult['recovery'] = null;

  // Non-Arabic target (or disabled) -> just normalize digits.
  if (target !== 'ar') {
    return {
      displayLanguage: rec.language,
      originalLanguage: rec.language,
      questionText: W(rec.questionText),
      choices: rec.choices ? rec.choices.map(W) : null,
      recovery,
    };
  }

  // Cached Arabic translation?
  if (rec.arabicText) {
    return {
      displayLanguage: 'ar',
      originalLanguage: rec.language,
      questionText: W(rec.arabicText),
      choices: rec.arabicChoices ? rec.arabicChoices.map(W) : rec.choices?.map(W) ?? null,
      recovery,
    };
  }

  // Arabic source.
  if (rec.language === 'ar') {
    if (isUnclearArabic(rec.questionText)) {
      // Recover unclear values from the English variant, then present in Arabic.
      const counterpart = await findEnglishCounterpart(rec).catch(() => null);
      if (counterpart && counterpart.confidence >= 0.6) {
        const ar = await translateToArabic(counterpart.rec.questionText, counterpart.rec.choices);
        if (ar) {
          setPayload(rec.id, { arabicText: ar.text, arabicChoices: ar.choices });
          return {
            displayLanguage: 'ar',
            originalLanguage: rec.language,
            questionText: ar.text,
            choices: ar.choices ?? null,
            recovery: {
              used: true,
              from: counterpart.rec.source,
              confidence: counterpart.confidence,
              note: 'Unclear Arabic text was recovered from the English source variant and re-presented in Arabic.',
            },
          };
        }
      }
      // Could not confidently recover: keep original Arabic, flag uncertainty.
      return {
        displayLanguage: 'ar',
        originalLanguage: rec.language,
        questionText: W(rec.questionText),
        choices: rec.choices ? rec.choices.map(W) : null,
        recovery: { used: false, note: 'Arabic text appears unclear and no confident English match was found.' },
      };
    }
    return {
      displayLanguage: 'ar',
      originalLanguage: rec.language,
      questionText: W(rec.questionText),
      choices: rec.choices ? rec.choices.map(W) : null,
      recovery,
    };
  }

  // English/other source -> translate to Arabic (cache), fall back to original.
  const ar = await translateToArabic(rec.questionText, rec.choices);
  if (ar) {
    setPayload(rec.id, { arabicText: ar.text, arabicChoices: ar.choices });
    return {
      displayLanguage: 'ar',
      originalLanguage: rec.language,
      questionText: ar.text,
      choices: ar.choices ?? (rec.choices ? rec.choices.map(W) : null),
      recovery,
    };
  }
  return {
    displayLanguage: rec.language,
    originalLanguage: rec.language,
    questionText: W(rec.questionText),
    choices: rec.choices ? rec.choices.map(W) : null,
    recovery: { used: false, note: 'Arabic presentation requires an LLM; returning original language.' },
  };
}

// Minimal, attribution-preserving Arabic-first view of a question (async).
export async function present(rec: QuestionRecord, opts: { includeAnswer?: boolean } = {}) {
  const p = await presentText(rec);
  const out: Record<string, unknown> = {
    id: rec.id,
    source: rec.source,
    page: rec.page,
    section: rec.section,
    number: rec.number,
    testNumber: rec.testNumber ?? null,
    category: rec.category ?? null,
    categoryEstimated: rec.categorySource === 'estimated',
    difficulty: rec.difficulty ?? null,
    difficultyEstimated: rec.difficultyEstimated,
    questionText: p.questionText,
    choices: p.choices,
    displayLanguage: p.displayLanguage,
    originalLanguage: p.originalLanguage,
    recovery: p.recovery,
    confidence: rec.confidence ?? 1,
    hasImage: rec.hasImage,
    requiresImage: rec.requiresImage,
    imageUrls: rec.imageRefs.map(imageUrl),
    attribution: {
      source: rec.source,
      variantGroup: rec.variantGroup ?? null,
      page: rec.page,
      section: rec.section ?? null,
      testNumber: rec.testNumber ?? null,
      questionNumber: rec.number ?? null,
      originalLanguage: rec.language,
    },
  };
  if (opts.includeAnswer) {
    out.correctAnswer = W(rec.correctAnswer) || null;
    out.answerAvailable = rec.answerSource === 'source';
    out.explanation = rec.explanation ? W(rec.explanation) : null;
    out.explanationSource = rec.explanationSource;
  }
  return out;
}

// Minimal, attribution-preserving public view of a question (sync; digits normalized).
export function publicQuestion(rec: QuestionRecord, opts: { includeAnswer?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: rec.id,
    source: rec.source,
    page: rec.page,
    section: rec.section,
    number: rec.number,
    language: rec.language,
    variantGroup: rec.variantGroup ?? null,
    category: rec.category ?? null,
    categoryEstimated: rec.categorySource === 'estimated',
    difficulty: rec.difficulty ?? null,
    difficultyEstimated: rec.difficultyEstimated,
    questionText: W(rec.arabicText || rec.questionText),
    choices: (rec.arabicChoices || rec.choices)?.map(W) ?? null,
    hasImage: rec.hasImage,
    requiresImage: rec.requiresImage,
    imageUrls: rec.imageRefs.map(imageUrl),
    attribution: {
      source: rec.source,
      page: rec.page,
      section: rec.section ?? null,
    },
  };
  if (opts.includeAnswer) {
    out.correctAnswer = W(rec.correctAnswer) || null;
    out.answerAvailable = rec.answerSource === 'source';
    out.explanation = rec.explanation ? W(rec.explanation) : null;
    out.explanationSource = rec.explanationSource;
  }
  return out;
}

import { linkedVariantNames } from './variants.js';

export function listSources() {
  return documents
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      phase: d.phase ?? null,
      progress: d.progress ?? (d.status === 'ready' ? 100 : 0),
      pages: d.pages,
      tests: d.tests ?? 0,
      questions: d.questionCount,
      passages: d.passageCount,
      imagePages: d.imagePages,
      language: d.language ?? 'other',
      variantGroup: d.variantGroup ?? null,
      linkedVariants: linkedVariantNames(d),
      extractionMethod: d.extractionMethod ?? null,
      sizeBytes: d.sizeBytes ?? 0,
      categories: d.categories,
      sections: d.sections.length,
      error: d.error ?? null,
      warning: d.warning ?? null,
      indexedAt: d.indexedAt ?? null,
      fileUrl: `/rest/file/${d.id}`,
      downloadUrl: `/rest/file/${d.id}?download=1`,
    }));
}

export function getSourceInfo(name: string) {
  const doc = documents.all().find((d) => d.name === name || d.id === name);
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    phase: doc.phase ?? null,
    progress: doc.progress ?? null,
    pages: doc.pages,
    tests: doc.tests ?? 0,
    questions: doc.questionCount,
    passages: doc.passageCount,
    imagePages: doc.imagePages,
    language: doc.language ?? 'other',
    variantGroup: doc.variantGroup ?? null,
    linkedVariants: linkedVariantNames(doc),
    extractionMethod: doc.extractionMethod ?? null,
    categories: doc.categories,
    sections: doc.sections,
    indexedAt: doc.indexedAt ?? null,
    error: doc.error ?? null,
    warning: doc.warning ?? null,
    fileUrl: `/rest/file/${doc.id}`,
    downloadUrl: `/rest/file/${doc.id}?download=1`,
  };
}

// Resolve a safe file path for a document id (path-traversal safe).
export function resolveSourceFile(id: string): { path: string; name: string } | null {
  const doc = documents.all().find((d) => d.id === id);
  if (!doc) return null;
  const full = path.join(config.sourcesDir, path.basename(doc.name));
  const rel = path.relative(config.sourcesDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(full)) return null;
  return { path: full, name: doc.name };
}

export async function searchSources(params: {
  query: string;
  source?: string;
  category?: string;
  difficulty?: string;
  limit?: number;
}) {
  const vec = await getEmbedder().embedOne(params.query);
  const hits = await searchQuestions(vec, {
    limit: params.limit ?? 5,
    source: params.source,
    category: params.category,
    difficulty: params.difficulty,
  });
  return Promise.all(
    hits.map(async (h) => ({
      score: Number(h.score.toFixed(4)),
      ...(await present(h.payload)),
      type: h.payload.type,
    }))
  );
}

// Arabic-first: prefer an Arabic variant; fall back to any language.
async function scrollIdsArabicFirst(filter: {
  source?: string;
  category?: string;
  difficulty?: string;
}): Promise<string[]> {
  const ar = await scrollIds({ ...filter, type: 'question', language: 'ar' }, 4000);
  if (ar.length) return ar;
  return scrollIds({ ...filter, type: 'question' }, 4000);
}

async function randomQuestionRecord(filter: {
  source?: string;
  category?: string;
  difficulty?: string;
}): Promise<QuestionRecord | null> {
  const ids = await scrollIdsArabicFirst(filter);
  if (!ids.length) return null;
  return getById(pick(ids));
}

export async function getQuestion(params: {
  source?: string;
  category?: string;
  difficulty?: string;
  random?: boolean;
}) {
  let rec: QuestionRecord | null;
  if (params.random === false) {
    const ids = await scrollIdsArabicFirst(params);
    rec = ids.length ? await getById(ids[0]) : null;
  } else {
    rec = await randomQuestionRecord(params);
  }
  if (!rec) return null;
  return present(rec);
}

export async function getRandomQuestion(params: {
  source?: string;
  category?: string;
  difficulty?: string;
}) {
  const rec = await randomQuestionRecord(params);
  return rec ? present(rec) : null;
}

export async function generateQuiz(params: {
  number_of_questions: number;
  source?: string;
  category?: string;
  difficulty?: string;
  randomize?: boolean;
}) {
  const n = Math.max(1, Math.min(params.number_of_questions || 5, 50));
  const filter = {
    source: params.source,
    category: params.category,
    difficulty: params.difficulty,
  };
  let ids = await scrollIdsArabicFirst(filter);
  if (!ids.length) return { count: 0, questions: [] };
  ids = params.randomize === false ? ids.slice(0, n) : shuffle(ids).slice(0, n);
  const recs = (await Promise.all(ids.map((id) => getById(id)))).filter(Boolean) as QuestionRecord[];
  return {
    count: recs.length,
    filters: { source: params.source, category: params.category, difficulty: params.difficulty },
    // Answers intentionally omitted so the quiz can be administered blind.
    questions: await Promise.all(recs.map((r) => present(r))),
  };
}

async function resolveQuestion(ref: {
  questionId?: string;
  question?: string;
  source?: string;
}): Promise<QuestionRecord | null> {
  if (ref.questionId) {
    const r = await getById(ref.questionId);
    if (r) return r;
  }
  if (ref.question) {
    const vec = await getEmbedder().embedOne(ref.question);
    const hits = await searchQuestions(vec, { limit: 1, source: ref.source, type: 'question' });
    if (hits.length) return hits[0].payload;
  }
  return null;
}

function normAns(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function compareAnswer(
  user: string,
  correct: string,
  choices?: string[]
): boolean {
  const u = normAns(user);
  const c = normAns(correct);
  if (!u || !c) return false;
  if (u === c) return true;
  // Correct answer is a letter; user may have typed the option text (or vice versa).
  if (/^[a-e]$/.test(c) && choices) {
    const choice = choices.find((ch) => /^([A-E])\)/.exec(ch)?.[1].toLowerCase() === c);
    if (choice) {
      const text = normAns(choice.replace(/^[A-E]\)\s*/, ''));
      if (u === text || text.includes(u) || u.includes(text)) return true;
    }
  }
  if (/^[a-e]$/.test(u) && choices) {
    const choice = choices.find((ch) => /^([A-E])\)/.exec(ch)?.[1].toLowerCase() === u);
    if (choice) {
      const text = normAns(choice.replace(/^[A-E]\)\s*/, ''));
      if (text === c || text.includes(c) || c.includes(text)) return true;
    }
  }
  // Numeric comparison.
  const un = user.replace(/[^0-9.\-]/g, '');
  const cn = correct.replace(/[^0-9.\-]/g, '');
  if (un && cn && parseFloat(un) === parseFloat(cn)) return true;
  return false;
}

export async function checkAnswer(params: {
  questionId?: string;
  question?: string;
  user_answer: string;
  correct_answer?: string;
  explanation?: string;
  source?: string;
}) {
  const rec = await resolveQuestion(params);

  // English-variant recovery: if the Arabic source lacks a clear answer/text,
  // pull the corresponding English question's answer/explanation to verify.
  let recovered: { rec: QuestionRecord; confidence: number } | null = null;
  if (
    rec &&
    rec.language === 'ar' &&
    (!rec.correctAnswer || isUnclearArabic(rec.questionText) || !rec.explanation)
  ) {
    recovered = await findEnglishCounterpart(rec).catch(() => null);
    if (recovered && recovered.confidence < 0.6) recovered = null;
  }

  // Prefer source-provided answer/explanation over anything else.
  const correctAnswer =
    rec?.correctAnswer || recovered?.rec.correctAnswer || params.correct_answer;
  const answerSource: 'source' | 'recovered' | 'provided' | 'unknown' = rec?.correctAnswer
    ? 'source'
    : recovered?.rec.correctAnswer
      ? 'recovered'
      : params.correct_answer
        ? 'provided'
        : 'unknown';

  let explanation = rec?.explanation || recovered?.rec.explanation || params.explanation;
  let explanationSource: 'source' | 'recovered' | 'provided' | 'ai' | 'none' = rec?.explanation
    ? 'source'
    : recovered?.rec.explanation
      ? 'recovered'
      : params.explanation
        ? 'provided'
        : 'none';
  const qForLlm = recovered?.rec.questionText || rec?.questionText || params.question || '';
  const chForLlm = recovered?.rec.choices || rec?.choices || [];

  if (!correctAnswer) {
    // We refuse to fabricate a verdict when no authoritative answer exists.
    let aiNote: string | null = null;
    if (llmEnabled() && (rec || qForLlm)) {
      aiNote = await llmComplete(
        'أنت معلم اختبارات ذكاء دقيق. اشرح بإيجاز باللغة العربية الفصحى مع إبقاء جميع الأرقام بالصيغة الغربية (0-9).',
        `السؤال:\n${qForLlm}\n${chForLlm.join('\n')}\n\nإجابة المتعلم: "${params.user_answer}".\nلا يحتوي المصدر على مفتاح إجابة. قدّم أفضل إجابة مُعلَّلة وشرحاً موجزاً بالعربية، ووضّح أن هذا استنتاج بالذكاء الاصطناعي وليس من المصدر.`
      );
    }
    return {
      correct: null,
      note: 'No authoritative answer found in the source material for this question.',
      correctAnswer: null,
      answerSource,
      explanation: aiNote ? W(aiNote) : explanation ? W(explanation) : null,
      explanationSource: aiNote ? 'ai' : explanationSource,
      recovery: recovered
        ? { used: true, from: recovered.rec.source, confidence: recovered.confidence }
        : null,
      attribution: rec ? { source: rec.source, page: rec.page, section: rec.section ?? null } : null,
      requiresImage: rec?.requiresImage ?? false,
      imageUrls: rec ? rec.imageRefs.map(imageUrl) : [],
    };
  }

  const correct = compareAnswer(params.user_answer, correctAnswer, rec?.choices || chForLlm);

  // Only call the LLM to *explain* when neither the source nor the English variant has one.
  if (!explanation && llmEnabled() && qForLlm) {
    const ai = await llmComplete(
      'أنت معلم اختبارات ذكاء دقيق. اشرح المنطق بإيجاز (2-4 جمل) باللغة العربية الفصحى مع إبقاء جميع الأرقام بالصيغة الغربية (0-9).',
      `السؤال:\n${qForLlm}\n${chForLlm.join('\n')}\nالإجابة الصحيحة: ${correctAnswer}\nاشرح لماذا هذه هي الإجابة الصحيحة بالعربية.`
    );
    if (ai) {
      explanation = ai;
      explanationSource = 'ai';
    }
  }

  return {
    correct,
    userAnswer: params.user_answer,
    correctAnswer: W(correctAnswer) || null,
    answerSource,
    explanation: explanation ? W(explanation) : null,
    explanationSource,
    recovery: recovered
      ? { used: true, from: recovered.rec.source, confidence: recovered.confidence }
      : null,
    attribution: rec ? { source: rec.source, page: rec.page, section: rec.section ?? null } : null,
    requiresImage: rec?.requiresImage ?? false,
    imageUrls: rec ? rec.imageRefs.map(imageUrl) : [],
  };
}

export async function getExplanation(params: {
  questionId?: string;
  question?: string;
  source?: string;
}) {
  const rec = await resolveQuestion(params);
  if (!rec) return null;
  // English-variant recovery for unclear Arabic questions.
  let recovered: { rec: QuestionRecord; confidence: number } | null = null;
  if (rec.language === 'ar' && (!rec.explanation || isUnclearArabic(rec.questionText))) {
    recovered = await findEnglishCounterpart(rec).catch(() => null);
    if (recovered && recovered.confidence < 0.6) recovered = null;
  }
  const qText = recovered?.rec.questionText || rec.questionText;
  const qChoices = recovered?.rec.choices || rec.choices || [];
  const srcAnswer = rec.correctAnswer || recovered?.rec.correctAnswer;
  let explanation = rec.explanation || recovered?.rec.explanation;
  let explanationSource: 'source' | 'recovered' | 'ai' | 'none' = rec.explanation
    ? 'source'
    : recovered?.rec.explanation
      ? 'recovered'
      : 'none';
  if (!explanation && llmEnabled()) {
    const ai = await llmComplete(
      'أنت معلم اختبارات ذكاء دقيق. اشرح بإيجاز باللغة العربية الفصحى مع إبقاء جميع الأرقام بالصيغة الغربية (0-9).',
      `اشرح خطوة بخطوة وبإيجاز كيفية حل هذا السؤال بالعربية.\n${qText}\n${qChoices.join('\n')}${srcAnswer ? `\nالإجابة الصحيحة هي ${srcAnswer}.` : ''}`
    );
    if (ai) {
      explanation = ai;
      explanationSource = 'ai';
    }
  }
  const p = await presentText(rec);
  return {
    questionText: p.questionText,
    correctAnswer: W(srcAnswer) || null,
    answerAvailable: rec.answerSource === 'source' || !!recovered?.rec.correctAnswer,
    explanation: explanation ? W(explanation) : null,
    explanationSource,
    recovery: recovered
      ? { used: true, from: recovered.rec.source, confidence: recovered.confidence }
      : null,
    requiresImage: rec.requiresImage,
    imageUrls: rec.imageRefs.map(imageUrl),
    attribution: { source: rec.source, page: rec.page, section: rec.section ?? null },
  };
}

export async function getSimilarQuestions(params: {
  questionId?: string;
  question?: string;
  source?: string;
  category?: string;
  difficulty?: string;
  limit?: number;
}) {
  let seedText = params.question;
  let seedId: string | undefined;
  if (params.questionId) {
    const rec = await getById(params.questionId);
    if (rec) {
      seedText = [rec.section, rec.questionText, (rec.choices || []).join(' ')]
        .filter(Boolean)
        .join('\n');
      seedId = rec.id;
    }
  }
  if (!seedText) return [];
  const vec = await getEmbedder().embedOne(seedText);
  const hits = await searchQuestions(vec, {
    limit: (params.limit ?? 5) + 1,
    source: params.source,
    category: params.category,
    difficulty: params.difficulty,
    type: 'question',
  });
  return Promise.all(
    hits
      .filter((h) => h.payload.id !== seedId)
      .slice(0, params.limit ?? 5)
      .map(async (h) => ({ score: Number(h.score.toFixed(4)), ...(await present(h.payload)) }))
  );
}

export async function stats() {
  const totalQuestions = await countPoints({ type: 'question' }).catch(() => 0);
  const totalPassages = await countPoints({ type: 'passage' }).catch(() => 0);
  return {
    sources: documents.all().length,
    questions: totalQuestions,
    passages: totalPassages,
  };
}
