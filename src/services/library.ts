import { config } from '../config.js';
import { llmComplete, llmEnabled } from '../llm/index.js';
import { getEmbedder } from '../embeddings/index.js';
import {
  searchQuestions,
  getById,
  scrollIds,
  scrollRecords,
  countPoints,
} from '../vector/qdrant.js';
import { documents } from '../database/store.js';
import { shuffle, pick } from '../utils/text.js';
import type { QuestionRecord } from '../types.js';

export function imageUrl(ref: string): string {
  const base = config.publicBaseUrl || '';
  return `${base}/rest/images/${ref}`;
}

// Minimal, attribution-preserving public view of a question.
export function publicQuestion(rec: QuestionRecord, opts: { includeAnswer?: boolean } = {}) {
  const out: Record<string, unknown> = {
    id: rec.id,
    source: rec.source,
    page: rec.page,
    section: rec.section,
    number: rec.number,
    category: rec.category ?? null,
    categoryEstimated: rec.categorySource === 'estimated',
    difficulty: rec.difficulty ?? null,
    difficultyEstimated: rec.difficultyEstimated,
    questionText: rec.questionText,
    choices: rec.choices ?? null,
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
    out.correctAnswer = rec.correctAnswer ?? null;
    out.answerAvailable = rec.answerSource === 'source';
    out.explanation = rec.explanation ?? null;
    out.explanationSource = rec.explanationSource;
  }
  return out;
}

export function listSources() {
  return documents
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      pages: d.pages,
      questions: d.questionCount,
      passages: d.passageCount,
      imagePages: d.imagePages,
      categories: d.categories,
      sections: d.sections.length,
      indexedAt: d.indexedAt ?? null,
    }));
}

export function getSourceInfo(name: string) {
  const doc = documents.all().find((d) => d.name === name || d.id === name);
  if (!doc) return null;
  return {
    id: doc.id,
    name: doc.name,
    status: doc.status,
    pages: doc.pages,
    questions: doc.questionCount,
    passages: doc.passageCount,
    imagePages: doc.imagePages,
    categories: doc.categories,
    sections: doc.sections,
    indexedAt: doc.indexedAt ?? null,
    error: doc.error ?? null,
  };
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
  return hits.map((h) => ({
    score: Number(h.score.toFixed(4)),
    ...publicQuestion(h.payload),
    type: h.payload.type,
  }));
}

async function randomQuestionRecord(filter: {
  source?: string;
  category?: string;
  difficulty?: string;
}): Promise<QuestionRecord | null> {
  const ids = await scrollIds({ ...filter, type: 'question' }, 4000);
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
    const { records } = await scrollRecords(
      { source: params.source, category: params.category, difficulty: params.difficulty, type: 'question' },
      1
    );
    rec = records[0] ?? null;
  } else {
    rec = await randomQuestionRecord(params);
  }
  if (!rec) return null;
  return publicQuestion(rec);
}

export async function getRandomQuestion(params: {
  source?: string;
  category?: string;
  difficulty?: string;
}) {
  const rec = await randomQuestionRecord(params);
  return rec ? publicQuestion(rec) : null;
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
    type: 'question' as const,
  };
  let ids = await scrollIds(filter, 4000);
  if (!ids.length) return { count: 0, questions: [] };
  ids = params.randomize === false ? ids.slice(0, n) : shuffle(ids).slice(0, n);
  const recs = (await Promise.all(ids.map((id) => getById(id)))).filter(Boolean) as QuestionRecord[];
  return {
    count: recs.length,
    filters: { source: params.source, category: params.category, difficulty: params.difficulty },
    // Answers intentionally omitted so the quiz can be administered blind.
    questions: recs.map((r) => publicQuestion(r)),
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

  // Prefer source-provided answer/explanation over anything else.
  const correctAnswer = rec?.correctAnswer || params.correct_answer;
  const answerSource: 'source' | 'provided' | 'unknown' = rec?.correctAnswer
    ? 'source'
    : params.correct_answer
      ? 'provided'
      : 'unknown';

  let explanation = rec?.explanation || params.explanation;
  let explanationSource: 'source' | 'provided' | 'ai' | 'none' = rec?.explanation
    ? 'source'
    : params.explanation
      ? 'provided'
      : 'none';

  if (!correctAnswer) {
    // We refuse to fabricate a verdict when no authoritative answer exists.
    let aiNote: string | null = null;
    if (llmEnabled() && rec) {
      aiNote = await llmComplete(
        'You are a careful aptitude tutor. Be concise.',
        `Question:\n${rec.questionText}\n${(rec.choices || []).join('\n')}\n\nThe learner answered: "${params.user_answer}".\nThe source does not contain an answer key. Give your best reasoned answer and a short explanation, and explicitly note this is AI-derived, not from the source.`
      );
    }
    return {
      correct: null,
      note: 'No authoritative answer found in the source material for this question.',
      correctAnswer: null,
      answerSource,
      explanation: aiNote || explanation || null,
      explanationSource: aiNote ? 'ai' : explanationSource,
      attribution: rec ? { source: rec.source, page: rec.page, section: rec.section ?? null } : null,
      requiresImage: rec?.requiresImage ?? false,
      imageUrls: rec ? rec.imageRefs.map(imageUrl) : [],
    };
  }

  const correct = compareAnswer(params.user_answer, correctAnswer, rec?.choices);

  // Only call the LLM to *explain* when the source has no explanation.
  if (!explanation && llmEnabled() && rec) {
    const ai = await llmComplete(
      'You are a careful aptitude tutor. Explain the reasoning concisely in 2-4 sentences.',
      `Question:\n${rec.questionText}\n${(rec.choices || []).join('\n')}\nCorrect answer: ${correctAnswer}\nExplain why this is correct.`
    );
    if (ai) {
      explanation = ai;
      explanationSource = 'ai';
    }
  }

  return {
    correct,
    userAnswer: params.user_answer,
    correctAnswer,
    answerSource,
    explanation: explanation || null,
    explanationSource,
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
  let explanation = rec.explanation;
  let explanationSource: 'source' | 'ai' | 'none' = rec.explanation ? 'source' : 'none';
  if (!explanation && llmEnabled()) {
    const ai = await llmComplete(
      'You are a careful aptitude tutor. Explain concisely.',
      `Explain how to solve this question step by step, concisely.\n${rec.questionText}\n${(rec.choices || []).join('\n')}${rec.correctAnswer ? `\nThe correct answer is ${rec.correctAnswer}.` : ''}`
    );
    if (ai) {
      explanation = ai;
      explanationSource = 'ai';
    }
  }
  return {
    questionText: rec.questionText,
    correctAnswer: rec.correctAnswer ?? null,
    answerAvailable: rec.answerSource === 'source',
    explanation: explanation || null,
    explanationSource,
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
  return hits
    .filter((h) => h.payload.id !== seedId)
    .slice(0, params.limit ?? 5)
    .map((h) => ({ score: Number(h.score.toFixed(4)), ...publicQuestion(h.payload) }));
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
