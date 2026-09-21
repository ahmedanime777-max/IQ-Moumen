import 'dotenv/config';
import path from 'node:path';

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
function int(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SOURCES_DIR = path.resolve(process.env.SOURCES_DIR || './sources');

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  authToken: process.env.MCP_AUTH_TOKEN || '',

  sourcesDir: SOURCES_DIR,
  dataDir: DATA_DIR,
  imagesDir: path.join(DATA_DIR, 'images'),
  dbDir: path.join(DATA_DIR, 'db'),

  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || undefined,
    collection: process.env.QDRANT_COLLECTION || 'iq_questions',
  },

  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER || 'local') as 'local' | 'openai',
    localModel: process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    batchSize: int(process.env.EMBED_BATCH_SIZE, 32),
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'none') as 'none' | 'openai' | 'bridge',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    bridgeUrl: process.env.LLM_BRIDGE_URL || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  },

  ingestion: {
    chunkMaxChars: int(process.env.CHUNK_MAX_CHARS, 1200),
    chunkOverlap: int(process.env.CHUNK_OVERLAP_CHARS, 150),
    renderPageImages: bool(process.env.RENDER_PAGE_IMAGES, true),
    imageDpi: int(process.env.IMAGE_DPI, 110),
    autoIngest: bool(process.env.AUTO_INGEST, true),
  },
};

export const CATEGORIES = [
  'Numerical reasoning',
  'Verbal reasoning',
  'Logical reasoning',
  'Abstract reasoning',
  'Spatial reasoning',
  'Pattern recognition',
  'Sequences',
  'Analogies',
  'Matrices',
  'Percentages',
  'Ratios',
  'Word problems',
  'Critical thinking',
  'Other',
] as const;

export const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Very Hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
