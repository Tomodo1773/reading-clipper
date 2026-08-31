import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import mcpEdge, { getAccessSubject, type McpEdgeEnv } from '../src/mcp-edge';

const AUD = 'access-audience';
const EMAIL = 'owner@example.com';
const HOST = 'mcp.example.com';

function edgeEnv(overrides: Partial<McpEdgeEnv> = {}) {
  const callTool = vi.fn(async () => ({ found: [] }));
  const clipPage = vi.fn(async () => '<!doctype html>\n<html lang="ja"><body>Clips</body></html>');
  return {
    env: {
      CORE: { callTool, clipPage } as unknown as McpEdgeEnv['CORE'],
      ACCESS_AUD: AUD,
      ACCESS_ALLOWED_EMAIL: EMAIL,
      MCP_HOSTNAME: HOST,
      ...overrides,
    },
    callTool,
    clipPage,
  };
}

/** 閲覧ページはブラウザからのGETで、Originヘッダを持たない。 */
function pageRequest(path = '/clips', headers: HeadersInit = {}): Request {
  return new Request(`https://${HOST}${path}`, { headers: { host: HOST, ...headers } });
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
      "default-src 'none'; img-src https:; style-src 'unsafe-inline'",
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
});
