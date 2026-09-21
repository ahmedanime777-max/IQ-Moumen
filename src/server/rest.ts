import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import * as lib from '../services/library.js';
import { scrollRecords } from '../vector/qdrant.js';
import {
  syncSources,
  reindexAll,
  reindexOne,
  deleteSource,
  jobStatus,
  planSync,
} from '../ingestion/manager.js';
import { publicQuestion } from '../services/library.js';

function sanitize(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._ -]/g, '_');
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.pdf')),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// PDFs are persisted to the configured sources directory (a mounted Docker
// volume in production). This is intentional: the sources dir is the durable
// library that the ingestion pipeline and re-index scripts operate on.
function persistUpload(file: Express.Multer.File): string {
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  const name = sanitize(file.originalname);
  fs.writeFileSync(path.join(config.sourcesDir, name), file.buffer);
  return name;
}

export const rest = Router();

rest.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

rest.get('/config', (_req, res) => {
  const base = config.publicBaseUrl || `http://localhost:${config.port}`;
  res.json({
    mcpUrl: `${base}/mcp`,
    authRequired: !!config.authToken,
    embeddingProvider: config.embeddings.provider,
    llmProvider: config.llm.provider,
    autoIngest: config.ingestion.autoIngest,
  });
});

rest.get('/stats', async (_req, res) => {
  res.json(await lib.stats());
});

rest.get('/sources', (_req, res) => res.json({ sources: lib.listSources() }));

rest.get('/sources/:name', (req, res) => {
  const info = lib.getSourceInfo(req.params.name);
  if (!info) return res.status(404).json({ error: 'Source not found' });
  res.json(info);
});

rest.post('/upload', upload.array('files', 20), async (req, res) => {
  const files = ((req.files as Express.Multer.File[]) || []).map((f) => persistUpload(f));
  const plan = await syncSources();
  res.json({ uploaded: files, plan, jobStatus });
});

rest.post('/sync', async (_req, res) => {
  const plan = await syncSources();
  res.json({ plan, jobStatus });
});

rest.get('/sync-plan', (_req, res) => res.json(planSync()));

rest.post('/reindex', async (req, res) => {
  const source = req.body?.source as string | undefined;
  if (source) await reindexOne(source);
  else await reindexAll(true);
  res.json({ ok: true, jobStatus });
});

rest.delete('/sources/:name', async (req, res) => {
  await deleteSource(req.params.name);
  res.json({ ok: true });
});

rest.post('/search', async (req, res) => {
  const { query, source, category, difficulty, limit } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });
  res.json({ results: await lib.searchSources({ query, source, category, difficulty, limit }) });
});

rest.get('/questions', async (req, res) => {
  const { source, category, difficulty } = req.query as Record<string, string>;
  const limit = Math.min(parseInt((req.query.limit as string) || '30', 10), 100);
  const { records } = await scrollRecords(
    { source, category, difficulty, type: 'question' },
    limit
  );
  res.json({ questions: records.map((r) => publicQuestion(r, { includeAnswer: true })) });
});

rest.get('/ingest-status', (_req, res) => res.json(jobStatus));
