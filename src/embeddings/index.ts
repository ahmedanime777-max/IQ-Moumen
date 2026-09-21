import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

// ---- Local (offline) embeddings via @xenova/transformers ----
class LocalEmbedder implements Embedder {
  dim = 384;
  private extractor: any = null;
  private ready: Promise<void> | null = null;

  private async init() {
    if (this.extractor) return;
    if (!this.ready) {
      this.ready = (async () => {
        process.env.TRANSFORMERS_CACHE = config.dataDir + '/models';
        const { pipeline, env } = await import('@xenova/transformers');
        env.cacheDir = config.dataDir + '/models';
        logger.info(`Loading local embedding model: ${config.embeddings.localModel}`);
        this.extractor = await pipeline('feature-extraction', config.embeddings.localModel);
        const probe = await this.extractor(['x'], { pooling: 'mean', normalize: true });
        this.dim = probe.dims[probe.dims.length - 1];
        logger.info(`Local embedder ready (dim=${this.dim})`);
      })();
    }
    await this.ready;
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init();
    if (texts.length === 0) return [];
    const out = await this.extractor(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  }

  async embedOne(text: string): Promise<number[]> {
    return (await this.embed([text]))[0];
  }
}

// ---- OpenAI-compatible embeddings ----
class OpenAIEmbedder implements Embedder {
  dim = 1536;
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${config.embeddings.openaiBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.embeddings.openaiKey}`,
      },
      body: JSON.stringify({ model: config.embeddings.openaiModel, input: texts }),
    });
    if (!res.ok) throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    const vecs = json.data.map((d: any) => d.embedding as number[]);
    if (vecs[0]) this.dim = vecs[0].length;
    return vecs;
  }
  async embedOne(text: string): Promise<number[]> {
    return (await this.embed([text]))[0];
  }
}

let singleton: Embedder | null = null;
export function getEmbedder(): Embedder {
  if (singleton) return singleton;
  singleton =
    config.embeddings.provider === 'openai' ? new OpenAIEmbedder() : new LocalEmbedder();
  return singleton;
}

// Embed in batches to keep memory/latency bounded.
export async function embedBatched(texts: string[]): Promise<number[][]> {
  const embedder = getEmbedder();
  const size = config.embeddings.batchSize;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const vecs = await embedder.embed(batch);
    out.push(...vecs);
  }
  return out;
}
