import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { QuestionRecord } from '../types.js';

let client: QdrantClient | null = null;
export function qdrant(): QdrantClient {
  if (!client) {
    client = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
      checkCompatibility: false,
    });
  }
  return client;
}

export async function ensureCollection(dim: number): Promise<void> {
  const c = qdrant();
  const name = config.qdrant.collection;
  const existing = await c.getCollections();
  const found = existing.collections.find((x) => x.name === name);
  if (found) {
    const info = await c.getCollection(name);
    const size = (info.config?.params?.vectors as any)?.size;
    if (size && size !== dim) {
      logger.warn(`Collection ${name} has dim ${size} but embedder is ${dim}; recreating.`);
      await c.deleteCollection(name);
    } else {
      return;
    }
  }
  logger.info(`Creating Qdrant collection ${name} (dim=${dim})`);
  await c.createCollection(name, {
    vectors: { size: dim, distance: 'Cosine' },
  });
  // Payload indexes for fast filtering.
  for (const field of [
    'source',
    'documentId',
    'category',
    'difficulty',
    'type',
    'contentHash',
    'language',
    'variantGroup',
  ]) {
    try {
      await c.createPayloadIndex(name, { field_name: field, field_schema: 'keyword' });
    } catch {
      /* index may already exist */
    }
  }
}

type Filter = {
  source?: string;
  category?: string;
  difficulty?: string;
  type?: string;
  language?: string;
};

function buildFilter(f: Filter): any {
  const must: any[] = [];
  if (f.source) must.push({ key: 'source', match: { value: f.source } });
  if (f.category) must.push({ key: 'category', match: { value: f.category } });
  if (f.difficulty) must.push({ key: 'difficulty', match: { value: f.difficulty } });
  if (f.type) must.push({ key: 'type', match: { value: f.type } });
  if (f.language) must.push({ key: 'language', match: { value: f.language } });
  return must.length ? { must } : undefined;
}

// Merge a partial payload into an existing point (used to cache Arabic translations).
export async function setPayload(id: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await qdrant().setPayload(config.qdrant.collection, { payload, points: [id] });
  } catch {
    /* best-effort cache */
  }
}

export async function upsertQuestions(
  points: { vector: number[]; payload: QuestionRecord }[]
): Promise<void> {
  if (points.length === 0) return;
  await rq(() =>
    qdrant().upsert(config.qdrant.collection, {
      wait: true,
      points: points.map((p) => ({ id: p.payload.id, vector: p.vector, payload: p.payload as any })),
    })
  );
}

export interface SearchHit {
  score: number;
  payload: QuestionRecord;
}

// Retry wrapper for transient Qdrant/undici network errors ("other side closed",
// "fetch failed", socket resets) that occur under heavy sequential load.
async function rq<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.message || e) + ' ' + String(e?.cause?.message || '');
      if (!/fetch failed|other side closed|ECONNRESET|socket hang up|terminated|EPIPE|network/i.test(msg))
        throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}



export async function searchQuestions(
  vector: number[],
  opts: { limit?: number } & Filter = {}
): Promise<SearchHit[]> {
  const res = await rq(() =>
    qdrant().search(config.qdrant.collection, {
      vector,
      limit: opts.limit ?? 5,
      filter: buildFilter(opts),
      with_payload: true,
    })
  );
  return res.map((r) => ({ score: r.score ?? 0, payload: r.payload as unknown as QuestionRecord }));
}

export async function getById(id: string): Promise<QuestionRecord | null> {
  const res = await rq(() =>
    qdrant().retrieve(config.qdrant.collection, { ids: [id], with_payload: true })
  );
  if (!res.length) return null;
  return res[0].payload as unknown as QuestionRecord;
}

export async function scrollIds(f: Filter, cap = 4000): Promise<string[]> {
  const ids: string[] = [];
  let offset: any = undefined;
  const filter = buildFilter(f);
  while (ids.length < cap) {
    const res: any = await rq(() =>
      qdrant().scroll(config.qdrant.collection, {
        filter,
        limit: 256,
        offset,
        with_payload: false,
        with_vector: false,
      })
    );
    for (const p of res.points) ids.push(String(p.id));
    if (!res.next_page_offset) break;
    offset = res.next_page_offset;
  }
  return ids;
}

export async function scrollRecords(f: Filter, limit = 50, offsetToken?: any): Promise<{
  records: QuestionRecord[];
  next?: any;
}> {
  const res: any = await rq(() =>
    qdrant().scroll(config.qdrant.collection, {
      filter: buildFilter(f),
      limit,
      offset: offsetToken,
      with_payload: true,
      with_vector: false,
    })
  );
  return {
    records: res.points.map((p: any) => p.payload as QuestionRecord),
    next: res.next_page_offset,
  };
}

export async function countPoints(f: Filter): Promise<number> {
  const res = await rq(() =>
    qdrant().count(config.qdrant.collection, { filter: buildFilter(f), exact: true })
  );
  return res.count;
}

export async function deleteBySource(source: string): Promise<void> {
  await rq(() =>
    qdrant().delete(config.qdrant.collection, {
      wait: true,
      filter: { must: [{ key: 'source', match: { value: source } }] },
    })
  );
}

export async function findNearDuplicate(
  vector: number[],
  threshold: number
): Promise<QuestionRecord | null> {
  const res = await rq(() =>
    qdrant().search(config.qdrant.collection, { vector, limit: 1, with_payload: true })
  );
  if (res.length && (res[0].score ?? 0) >= threshold) {
    return res[0].payload as unknown as QuestionRecord;
  }
  return null;
}
