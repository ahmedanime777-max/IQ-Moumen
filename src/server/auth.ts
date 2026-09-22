import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { verifyAccessToken } from './oauth.js';

// Accepts EITHER a valid OAuth 2.1 access token (for ChatGPT) OR the static
// MCP_AUTH_TOKEN bearer (for simple/non-ChatGPT clients). Backward compatible.
export function requireBearer(req: Request, res: Response, next: NextFunction) {
  const header = (req.headers['authorization'] as string) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  // No auth configured at all -> open.
  if (!config.authToken && !config.oauth.enabled) return next();

  if (token) {
    if (config.authToken && token === config.authToken) return next();
    if (config.oauth.enabled && verifyAccessToken(token)) return next();
  }

  const base = config.publicBaseUrl || `http://localhost:${config.port}`;
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"`
    )
    .json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: valid OAuth access token or Bearer token required.' },
      id: null,
    });
}
