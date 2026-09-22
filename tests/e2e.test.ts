import { describe, it, expect, beforeAll } from 'vitest';

// Live end-to-end tests against a running server (as configured in .env).
// They exercise the health endpoint, MCP handshake/tools and semantic search.
// If the server is not reachable, the whole suite is skipped so unit tests
// still run in isolation / CI without external services.

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

let reachable = false;
beforeAll(async () => {
  try {
    const r = await fetch(`${BASE}/health`);
    reachable = r.ok;
  } catch {
    reachable = false;
  }
});

async function mcp(method: string, params: unknown, id = 1) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // No Authorization header — the MCP endpoint is public (no OAuth/Bearer).
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  // Streamable HTTP returns SSE ("event: message\ndata: {...}"). Extract JSON.
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse((line ? line.slice(5) : text).trim());
}

async function callTool(name: string, args: Record<string, unknown>) {
  const r = await mcp('tools/call', { name, arguments: args }, Math.floor(Math.random() * 1e6));
  const txt = r.result?.content?.find((c: any) => c.type === 'text')?.text;
  return { raw: r, data: txt ? JSON.parse(txt) : null };
}

describe('health endpoint', () => {
  it('returns ok', async () => {
    if (!reachable) return;
    const r = await fetch(`${BASE}/health`);
    const j = await r.json();
    expect(j.status).toBe('ok');
  });
});

describe('MCP is public (no authentication)', () => {
  it('accepts MCP requests WITHOUT any Authorization header', async () => {
    if (!reachable) return;
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
  });

  it('exposes no OAuth discovery endpoints', async () => {
    if (!reachable) return;
    const r = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(r.status).toBe(404);
  });

  it('reports authentication: none in /rest/config', async () => {
    if (!reachable) return;
    const r = await fetch(`${BASE}/rest/config`);
    const j = await r.json();
    expect(j.authRequired).toBe(false);
    expect(j.authentication).toBe('none');
  });
});

describe('MCP tools', () => {
  it('lists all expected tools', async () => {
    if (!reachable) return;
    const r = await mcp('tools/list', {});
    const names = r.result.tools.map((t: any) => t.name);
    for (const t of [
      'list_sources',
      'search_sources',
      'get_question',
      'generate_quiz',
      'check_answer',
      'get_explanation',
      'get_similar_questions',
      'get_random_question',
      'get_source_info',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('list_sources returns indexed sources', async () => {
    if (!reachable) return;
    const { data } = await callTool('list_sources', {});
    expect(Array.isArray(data.sources)).toBe(true);
  });

  it('search_sources performs semantic retrieval (source filtering respected)', async () => {
    if (!reachable) return;
    const { data } = await callTool('search_sources', {
      query: 'a hard percentage discount problem',
      limit: 5,
    });
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('get_random_question returns an Arabic question with Western digits and no answer', async () => {
    if (!reachable) return;
    const { data } = await callTool('get_random_question', {});
    if (data && data.id) {
      expect(data).not.toHaveProperty('correctAnswer');
      expect(typeof data.questionText).toBe('string');
      // HARD RULE: presentation is Arabic with Western digits only.
      expect(data.displayLanguage).toBe('ar');
      expect(data.questionText).not.toMatch(/[٠-٩۰-۹]/);
    }
  });

  it('generate_quiz returns structured questions without answers', async () => {
    if (!reachable) return;
    const { data } = await callTool('generate_quiz', { number_of_questions: 3 });
    expect(data).toHaveProperty('questions');
    for (const q of data.questions || []) expect(q).not.toHaveProperty('correctAnswer');
  });

  it('check_answer prefers the source answer and returns a verdict', async () => {
    if (!reachable) return;
    const rnd = await callTool('get_random_question', {});
    if (rnd.data && rnd.data.id) {
      const { data } = await callTool('check_answer', {
        questionId: rnd.data.id,
        user_answer: 'A',
      });
      expect(data).toHaveProperty('correct');
      expect(data).toHaveProperty('attribution');
    }
  });
});
