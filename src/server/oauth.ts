import type { Express, Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// ---- Minimal but real OAuth 2.1 authorization server for the MCP endpoint ----
// Implements the discovery/registration/authorize/token endpoints that ChatGPT's
// remote-MCP connector expects. Access tokens are stateless HS256 JWTs; refresh
// tokens are opaque and persisted so long-lived ChatGPT connections survive restarts.

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created: number;
}
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope: string;
  exp: number;
}

const clients = new Map<string, OAuthClient>();
const codes = new Map<string, AuthCode>();
const refreshFile = path.join(config.dbDir, 'oauth_refresh.json');
const refreshTokens: Record<string, { clientId: string; scope: string; exp: number }> = (() => {
  try {
    return JSON.parse(fs.readFileSync(refreshFile, 'utf8'));
  } catch {
    return {};
  }
})();
function persistRefresh() {
  try {
    fs.mkdirSync(config.dbDir, { recursive: true });
    fs.writeFileSync(refreshFile, JSON.stringify(refreshTokens));
  } catch {
    /* best-effort */
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const rand = (n = 32) => b64url(crypto.randomBytes(n));

function issuer(): string {
  return config.publicBaseUrl || `http://localhost:${config.port}`;
}

function signAccessToken(clientId: string, scope: string): string {
  return jwt.sign(
    { scope, typ: 'access' },
    config.oauth.signingSecret,
    { algorithm: 'HS256', expiresIn: config.oauth.accessTtl, subject: clientId, issuer: issuer(), audience: `${issuer()}/mcp` }
  );
}

export function verifyAccessToken(token: string): { sub?: string; scope?: string } | null {
  try {
    const p = jwt.verify(token, config.oauth.signingSecret, { algorithms: ['HS256'] }) as any;
    if (p.typ && p.typ !== 'access') return null;
    return p;
  } catch {
    return null;
  }
}

function verifyPkce(code: AuthCode, verifier?: string): boolean {
  if (!code.codeChallenge) return true; // no PKCE was requested
  if (!verifier) return false;
  if (code.codeChallengeMethod === 'S256' || !code.codeChallengeMethod) {
    const hash = b64url(crypto.createHash('sha256').update(verifier).digest());
    return hash === code.codeChallenge;
  }
  return verifier === code.codeChallenge; // plain
}

export function mountOAuth(app: Express) {
  if (!config.oauth.enabled) return;

  const meta = (_req: Request, res: Response) =>
    res.json({
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/oauth/authorize`,
      token_endpoint: `${issuer()}/oauth/token`,
      registration_endpoint: `${issuer()}/oauth/register`,
      scopes_supported: ['mcp', 'offline_access'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });

  // Discovery documents (support both bare and /mcp-suffixed resource metadata).
  app.get('/.well-known/oauth-authorization-server', meta);
  app.get('/.well-known/oauth-authorization-server/mcp', meta);
  app.get('/.well-known/openid-configuration', meta);
  const resourceMeta = (_req: Request, res: Response) =>
    res.json({
      resource: `${issuer()}/mcp`,
      authorization_servers: [issuer()],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp', 'offline_access'],
    });
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMeta);

  // Dynamic client registration (RFC 7591).
  app.post('/oauth/register', (req: Request, res: Response) => {
    const body = req.body || {};
    const client: OAuthClient = {
      client_id: `mcp-${rand(12)}`,
      client_name: body.client_name || 'ChatGPT MCP Client',
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris : [],
      created: Date.now(),
    };
    clients.set(client.client_id, client);
    logger.info(`OAuth client registered: ${client.client_id}`);
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // Authorization endpoint. No end-user login (single-user private server): a
  // registered client with valid PKCE is auto-approved and redirected with a code.
  app.get('/oauth/authorize', (req: Request, res: Response) => {
    const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method, scope } =
      req.query as Record<string, string>;
    if (response_type !== 'code' || !client_id || !redirect_uri) {
      return res.status(400).send('invalid_request');
    }
    // Auto-register unknown clients (some clients skip DCR) to stay compatible.
    if (!clients.has(client_id)) {
      clients.set(client_id, { client_id, redirect_uris: [redirect_uri], created: Date.now() });
    }
    const code = rand(24);
    codes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      scope: scope || 'mcp offline_access',
      exp: Date.now() + 10 * 60 * 1000,
    });
    const u = new URL(redirect_uri);
    u.searchParams.set('code', code);
    if (state) u.searchParams.set('state', state);
    res.redirect(u.toString());
  });

  // Token endpoint: authorization_code (+PKCE) and refresh_token grants.
  app.post('/oauth/token', (req: Request, res: Response) => {
    const b = req.body || {};
    const grant = b.grant_type;

    if (grant === 'authorization_code') {
      const code = codes.get(b.code);
      if (!code || code.exp < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
      codes.delete(b.code);
      if (b.redirect_uri && b.redirect_uri !== code.redirectUri)
        return res.status(400).json({ error: 'invalid_grant' });
      if (!verifyPkce(code, b.code_verifier))
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE failed' });
      const access = signAccessToken(code.clientId, code.scope);
      const refresh = rand(32);
      refreshTokens[refresh] = {
        clientId: code.clientId,
        scope: code.scope,
        exp: Date.now() + config.oauth.refreshTtl * 1000,
      };
      persistRefresh();
      return res.json({
        access_token: access,
        token_type: 'Bearer',
        expires_in: config.oauth.accessTtl,
        refresh_token: refresh,
        scope: code.scope,
      });
    }

    if (grant === 'refresh_token') {
      const rt = refreshTokens[b.refresh_token];
      if (!rt || rt.exp < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
      const access = signAccessToken(rt.clientId, rt.scope);
      return res.json({
        access_token: access,
        token_type: 'Bearer',
        expires_in: config.oauth.accessTtl,
        scope: rt.scope,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  logger.info(`OAuth 2.1 endpoints mounted (issuer ${issuer()})`);
}
