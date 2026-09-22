import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { buildMcpServer } from './mcp.js';
import { rest } from './rest.js';
import { startWatcher, syncSources } from '../ingestion/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ---- Health ----
const health = (_req: express.Request, res: express.Response) =>
  res.json({ status: 'ok', service: 'iq-aptitude-mcp', time: new Date().toISOString() });
app.get('/health', health);

// ---- MCP endpoint (Streamable HTTP, stateless) — PUBLIC, no authentication ----
async function handleMcp(req: express.Request, res: express.Response) {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    logger.error('MCP request failed', String(e));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}
app.post('/mcp', handleMcp);
// Alias so the endpoint is reachable behind /api-prefixed ingress rules too.
app.post('/api/mcp', handleMcp);

const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP.' },
    id: null,
  });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// ---- Dashboard REST API + image serving ----
app.use('/rest/images', express.static(config.imagesDir));
app.use('/rest', rest);
app.get('/api/health', health);

// ---- Dashboard static UI ----
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

export async function start() {
  app.listen(config.port, config.host, async () => {
    logger.info(`IQ Aptitude MCP server listening on http://${config.host}:${config.port}`);
    logger.info(`MCP endpoint: POST /mcp  (authentication: none)`);
    logger.info(`Embeddings: ${config.embeddings.provider} | LLM: ${config.llm.provider}`);
    // Auto-sync sources on boot, then watch for changes.
    if (config.ingestion.autoIngest) {
      syncSources({ background: true }).catch((e) => logger.error('initial sync failed', String(e)));
      startWatcher();
    }
  });
}

start();
