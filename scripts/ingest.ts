import { syncSources, jobStatus } from '../src/ingestion/manager.js';
import { logger } from '../src/utils/logger.js';

// Ingest any new/changed PDFs in the sources directory.
const plan = await syncSources({ deleteMissing: false });
logger.info('Ingestion plan', plan);
logger.info('Job status', { processed: jobStatus.processed, lastError: jobStatus.lastError });
process.exit(0);
