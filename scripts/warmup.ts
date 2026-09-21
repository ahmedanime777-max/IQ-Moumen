import { getEmbedder } from '../src/embeddings/index.js';
import { logger } from '../src/utils/logger.js';

// Pre-download / warm the local embedding model so first request is fast.
const e = getEmbedder();
await e.embed(['warmup query']);
logger.info(`Embedder ready (dim=${e.dim})`);
process.exit(0);
