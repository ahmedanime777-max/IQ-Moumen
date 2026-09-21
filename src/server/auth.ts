import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Bearer-token guard for the public MCP endpoint.
export function requireBearer(req: Request, res: Response, next: NextFunction) {
  if (!config.authToken) return next(); // auth disabled when no token configured
  const header = (req.headers['authorization'] as string) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token && token === config.authToken) return next();
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized: valid Bearer token required.' },
    id: null,
  });
}
