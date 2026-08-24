import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import mcpEdge, { getAccessAuditContext, type McpEdgeEnv } from '../src/mcp-edge';

const AUD = 'access-audience';
const EMAIL = 'owner@example.com';
const HOST = 'mcp.example.com';

function edgeEnv(overrides: Partial<McpEdgeEnv> = {}) {
  const callTool = vi.fn(async () => ({ found: [] }));
  return {
    env: {
      CORE: { callTool } as unknown as McpEdgeEnv['CORE'],
      ACCESS_AUD: AUD,
      ACCESS_ALLOWED_EMAIL: EMAIL,
      MCP_HOSTNAME: HOST,
      ...overrides,
    },
    callTool,
  };
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
    expect(await getAccessAuditContext(accessContext('other-audience'), env)).toBeUndefined();
  });

  it('rejects a different allowed identity', async () => {
    const { env } = edgeEnv();
    expect(
      await getAccessAuditContext(
        accessContext(AUD, { email: 'somebody-else@example.com', user_uuid: 'other' }),
        env,
      ),
    ).toBeUndefined();
  });

  it('propagates only an audit source and stable Access subject', async () => {
    const { env } = edgeEnv();
    expect(await getAccessAuditContext(accessContext(), env)).toEqual({
      source: 'mcp',
      subject: 'access-user-123',
    });
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
