import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fileSha256, stableUuid } from '../utils/hash.js';
import { ingestDocument } from './pipeline.js';
import { documents } from '../database/store.js';
import { deleteBySource } from '../vector/qdrant.js';

export interface JobStatus {
  running: boolean;
  current?: string;
  queue: string[];
  lastError?: string;
  lastRunAt?: string;
  processed: string[];
}

export const jobStatus: JobStatus = { running: false, queue: [], processed: [] };

export function listSourceFiles(): string[] {
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  return fs
    .readdirSync(config.sourcesDir)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => path.join(config.sourcesDir, f));
}

// Detect new / modified / unchanged / deleted documents by comparing file hashes.
export interface SyncPlan {
  added: string[];
  modified: string[];
  unchanged: string[];
  deleted: string[];
}

export function planSync(): SyncPlan {
  const files = listSourceFiles();
  const byName = new Map(files.map((f) => [path.basename(f), f]));
  const plan: SyncPlan = { added: [], modified: [], unchanged: [], deleted: [] };

  for (const [name, full] of byName) {
    const rec = documents.get(stableUuid(name));
    if (!rec) plan.added.push(name);
    else if (rec.fileHash !== fileSha256(full)) plan.modified.push(name);
    else if (rec.status !== 'ready') plan.modified.push(name);
    else plan.unchanged.push(name);
  }
  for (const rec of documents.all()) {
    if (!byName.has(rec.name)) plan.deleted.push(rec.name);
  }
  return plan;
}

async function runQueue() {
  if (jobStatus.running) return;
  jobStatus.running = true;
  try {
    while (jobStatus.queue.length) {
      const name = jobStatus.queue.shift()!;
      jobStatus.current = name;
      const full = path.join(config.sourcesDir, name);
      if (!fs.existsSync(full)) continue;
      try {
        await ingestDocument(full);
        jobStatus.processed.push(name);
      } catch (e) {
        jobStatus.lastError = `${name}: ${String(e)}`;
      }
    }
  } finally {
    jobStatus.current = undefined;
    jobStatus.running = false;
    jobStatus.lastRunAt = new Date().toISOString();
  }
}

export async function enqueueIngest(names: string[]): Promise<void> {
  for (const n of names) if (!jobStatus.queue.includes(n)) jobStatus.queue.push(n);
  await runQueue();
}

export async function syncSources(opts: { deleteMissing?: boolean } = {}): Promise<SyncPlan> {
  const plan = planSync();
  if (opts.deleteMissing !== false) {
    for (const name of plan.deleted) await deleteSource(name);
  }
  await enqueueIngest([...plan.added, ...plan.modified]);
  return plan;
}

export async function reindexAll(force = true): Promise<void> {
  const names = listSourceFiles().map((f) => path.basename(f));
  if (force) {
    for (const name of names) {
      const rec = documents.get(stableUuid(name));
      if (rec) documents.set(rec.id, { ...rec, status: 'pending' });
    }
  }
  await enqueueIngest(names);
}

export async function reindexOne(name: string): Promise<void> {
  await enqueueIngest([name]);
}

export async function deleteSource(name: string): Promise<void> {
  const id = stableUuid(name);
  await deleteBySource(name);
  const file = path.join(config.sourcesDir, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  const imgDir = path.join(config.imagesDir, id);
  if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true });
  documents.delete(id);
  logger.info(`Deleted source ${name}`);
}

let watching = false;
export function startWatcher() {
  if (watching || !config.ingestion.autoIngest) return;
  fs.mkdirSync(config.sourcesDir, { recursive: true });
  watching = true;
  let timer: NodeJS.Timeout | null = null;
  fs.watch(config.sourcesDir, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      syncSources().catch((e) => logger.error('watch sync failed', String(e)));
    }, 1500);
  });
  logger.info(`Watching ${config.sourcesDir} for new/changed PDFs`);
}
