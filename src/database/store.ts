import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { DocumentRecord, QuizRecord } from '../types.js';

// Small JSON-file persistence for the document registry and quiz sessions.
// Question data itself lives in Qdrant (vectors + payload).
class JsonStore<T> {
  private file: string;
  private data: Record<string, T> = {};
  private loaded = false;

  constructor(fileName: string) {
    this.file = path.join(config.dbDir, fileName);
  }

  private load() {
    if (this.loaded) return;
    fs.mkdirSync(config.dbDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch {
        this.data = {};
      }
    }
    this.loaded = true;
  }

  private persist() {
    fs.mkdirSync(config.dbDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get(id: string): T | undefined {
    this.load();
    return this.data[id];
  }
  all(): T[] {
    this.load();
    return Object.values(this.data);
  }
  set(id: string, value: T) {
    this.load();
    this.data[id] = value;
    this.persist();
  }
  delete(id: string) {
    this.load();
    delete this.data[id];
    this.persist();
  }
}

export const documents = new JsonStore<DocumentRecord>('documents.json');
export const quizzes = new JsonStore<QuizRecord>('quizzes.json');
