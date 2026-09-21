import { reindexAll, jobStatus } from '../src/ingestion/manager.js';
import { logger } from '../src/utils/logger.js';

// Force a full re-index of every PDF in the sources directory.
await reindexAll(true);
logger.info('Reindex complete', { processed: jobStatus.processed, lastError: jobStatus.lastError });
process.exit(0);
