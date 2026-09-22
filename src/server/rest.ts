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
    authRequired: false,
    authentication: 'none',
    embeddingProvider: config.embeddings.provider,
    llmProvider: config.llm.provider,
    presentLanguage: config.language.present,
    westernDigits: config.language.westernDigits,
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
  // Non-blocking: kick off ingestion in the background and return immediately
  // so large PDFs never hit the client/proxy upload timeout ("fetch failed").
  const plan = await syncSources({ background: true });
  res.json({ uploaded: files, plan, jobStatus });
});

rest.post('/sync', async (_req, res) => {
  const plan = await syncSources({ background: true });
  res.json({ plan, jobStatus });
});

rest.get('/sync-plan', (_req, res) => res.json(planSync()));

rest.post('/reindex', async (req, res) => {
  const source = req.body?.source as string | undefined;
  if (source) await reindexOne(source, true);
  else await reindexAll(true, true);
  res.json({ ok: true, jobStatus });
});

// Open / download the ORIGINAL uploaded PDF by safe document id (no path traversal).
rest.get('/file/:id', (req, res) => {
  const resolved = lib.resolveSourceFile(req.params.id);
  if (!resolved) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', 'application/pdf');
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(resolved.name)}"`);
  fs.createReadStream(resolved.path).pipe(res);
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
