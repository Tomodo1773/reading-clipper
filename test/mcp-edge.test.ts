import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import mcpEdge, { getAccessSubject, type McpEdgeEnv } from '../src/mcp-edge';

const AUD = 'access-audience';
const EMAIL = 'owner@example.com';
const HOST = 'mcp.example.com';

function edgeEnv(overrides: Partial<McpEdgeEnv> = {}) {
  const callTool = vi.fn(async (_audit: unknown, call: { name?: string }) =>
    call?.name === 'set_clip_dismissed'
      ? { updated: true, path: 'clips/a.md', dismissed: true }
      : { found: [] },
  );
  const clipPage = vi.fn(async () => '<!doctype html>\n<html lang="ja"><body>Clips</body></html>');
  const clipReadPage = vi.fn(async (_audit: unknown, path: string) =>
    path === 'clips/a.md' ? '<html lang="ja"><body>保存した本文</body></html>' : undefined,
  );
  return {
    env: {
      CORE: { callTool, clipPage, clipReadPage } as unknown as McpEdgeEnv['CORE'],
      ACCESS_AUD: AUD,
      ACCESS_ALLOWED_EMAIL: EMAIL,
      MCP_HOSTNAME: HOST,
      ...overrides,
    },
    callTool,
    clipPage,
    clipReadPage,
  };
}

/** 閲覧ページはブラウザからのGETで、Originヘッダを持たない。 */
function pageRequest(path = '/clips', headers: HeadersInit = {}): Request {
  return new Request(`https://${HOST}${path}`, { headers: { host: HOST, ...headers } });
}

function dismissRequest(path = 'clips/a.md', headers: HeadersInit = {}): Request {
  return new Request(`https://${HOST}/clips/dismiss`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: HOST,
      origin: `https://${HOST}`,
      ...headers,
    },
    body: new URLSearchParams({ path }),
  });
}

function accessContext(
  aud = AUD,
  identity: CloudflareAccessIdentity | undefined = {
    email: EMAIL,
    user_uuid: 'access-user-123',
  },
): CloudflareAccessContext {
  return { aud, getIdentity: async () => identity };
}

function executionContext(access?: CloudflareAccessContext): ExecutionContext {
  const ctx = createExecutionContext();
  if (access) Object.defineProperty(ctx, 'access', { value: access });
  return ctx;
}

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://${HOST}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      host: HOST,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('MCP Edge authentication', () => {
  it('does not call Core when Access context is missing', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(request({}), env, executionContext());

    expect(response.status).toBe(403);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects a different Access audience', async () => {
    const { env } = edgeEnv();
    expect(await getAccessSubject(accessContext('other-audience'), env)).toBeUndefined();
  });

  it('rejects a different allowed identity', async () => {
    const { env } = edgeEnv();
    expect(
      await getAccessSubject(
        accessContext(AUD, { email: 'somebody-else@example.com', user_uuid: 'other' }),
        env,
      ),
    ).toBeUndefined();
  });

  it('propagates only the stable Access subject', async () => {
    const { env } = edgeEnv();
    expect(await getAccessSubject(accessContext(), env)).toBe('access-user-123');
  });
});

describe('MCP Edge boundary', () => {
  it('rejects an unexpected Host', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      request({}, { host: 'attacker.example.com' }),
      env,
      executionContext(accessContext()),
    );
    expect(response.status).not.toBe(200);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('returns 404 for a path the boundary does not publish', async () => {
    const { env, callTool, clipPage } = edgeEnv();
    const response = await mcpEdge.fetch(
      pageRequest('/clips/extra'),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(404);
    expect(callTool).not.toHaveBeenCalled();
    expect(clipPage).not.toHaveBeenCalled();
  });

  it('rejects an unexpected Origin', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      request({}, { origin: 'https://attacker.example.com' }),
      env,
      executionContext(accessContext()),
    );
    expect(response.status).not.toBe(200);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('MCP Edge protocol', () => {
  it('lists the six Core tools through /mcp', async () => {
    const { env } = edgeEnv();
    const response = await mcpEdge.fetch(
      request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      env,
      executionContext(accessContext()),
    );
    const body = await response.text();
    const data = body.startsWith('event:')
      ? body.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
      : body;
    const payload = JSON.parse(data ?? '') as { result?: { tools?: Array<{ name: string }> } };

    expect(response.status).toBe(200);
    expect(payload.result?.tools?.map((tool) => tool.name)).toEqual([
      'load_content',
      'save_loaded',
      'list_clips',
      'find_clips',
      'read_clip',
      'delete_clip',
      'set_clip_dismissed',
    ]);
  });

  it('passes a tool call to Core with the minimal audit context', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'find_clips', arguments: { query: 'Durable Object' } },
      }),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(200);
    expect(callTool).toHaveBeenCalledWith(
      { source: 'mcp', subject: 'access-user-123' },
      { name: 'find_clips', args: { query: 'Durable Object' } },
    );
  });
});

describe('MCP Edge clip page', () => {
  it('serves the page Core renders, without touching the tool contract', async () => {
    const { env, callTool, clipPage } = edgeEnv();
    const response = await mcpEdge.fetch(
      pageRequest(),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'self'",
    );
    expect(await response.text()).toContain('<html lang="ja">');
    expect(clipPage).toHaveBeenCalledWith({ source: 'web', subject: 'access-user-123' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('does not render the page without an Access context', async () => {
    const { env, clipPage } = edgeEnv();
    const response = await mcpEdge.fetch(pageRequest(), env, executionContext());

    expect(response.status).toBe(403);
    expect(clipPage).not.toHaveBeenCalled();
  });

  it('rejects an unexpected Host on the page as well', async () => {
    const { env, clipPage } = edgeEnv();
    const response = await mcpEdge.fetch(
      pageRequest('/clips', { host: 'attacker.example.com' }),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).not.toBe(200);
    expect(clipPage).not.toHaveBeenCalled();
  });

  it('dismisses one clip through the shared Core tool and returns to the page', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      dismissRequest('clips/片付ける.md'),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/clips');
    expect(callTool).toHaveBeenCalledWith(
      { source: 'web', subject: 'access-user-123' },
      { name: 'set_clip_dismissed', args: { path: 'clips/片付ける.md', dismissed: true } },
    );
  });

  it('does not accept a state-changing form without an Origin', async () => {
    const { env, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      dismissRequest('clips/a.md', { origin: '' }),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(403);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('MCP Edge clip read page', () => {
  it('serves the body Core renders for one clip', async () => {
    const { env, clipReadPage, callTool } = edgeEnv();
    const response = await mcpEdge.fetch(
      pageRequest('/clips/read?path=clips%2Fa.md'),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(200);
    // ヘッダは一覧と同じ1箇所で組む。中身はそちらのテストが見ている。
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toContain('保存した本文');
    expect(clipReadPage).toHaveBeenCalledWith(
      { source: 'web', subject: 'access-user-123' },
      'clips/a.md',
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('returns 404 when Core has no such clip', async () => {
    const { env } = edgeEnv();
    const response = await mcpEdge.fetch(
      pageRequest('/clips/read?path=clips%2F消した記事.md'),
      env,
      executionContext(accessContext()),
    );

    expect(response.status).toBe(404);
  });
});
