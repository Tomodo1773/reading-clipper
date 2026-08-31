import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreMcpEntrypoint } from '../src/core-rpc';
import { recordClip } from '../src/clips';
import { resetGitHubTokenCache } from '../src/github';
import { utf8ToBase64 } from '../src/utils';
import { generatePrivateKeyPem, jsonResponse, makeEnv, resetClips } from './helpers';

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  await resetClips();
  privateKeyPem = await generatePrivateKeyPem();
});

afterEach(() => vi.restoreAllMocks());

describe('Core MCP RPC', () => {
  it('rejects an invalid audit context before executing a tool', async () => {
    const env = makeEnv();
    await expect(
      CoreMcpEntrypoint.prototype.callTool.call(
        { env } as unknown as CoreMcpEntrypoint,
        { source: 'mcp', subject: '' },
        { name: 'set_clip_dismissed', args: { path: 'clips/a.md', dismissed: true } },
      ),
    ).rejects.toThrow('invalid audit context');
  });

  it('executes the shared Core tool contract from the Service Binding entrypoint', async () => {
    const env = makeEnv();
    await recordClip(env, {
      path: 'clips/a.md',
      url: 'https://example.com/a',
      title: 'a',
      excerpt: 'a',
      clippedAt: '2026-08-24T00:00:00.000Z',
    });

    const result = await CoreMcpEntrypoint.prototype.callTool.call(
      { env } as unknown as CoreMcpEntrypoint,
      { source: 'mcp', subject: 'subject' },
      { name: 'set_clip_dismissed', args: { path: 'clips/a.md', dismissed: true } },
    );
    expect(result).toEqual({ updated: true, path: 'clips/a.md', dismissed: true });
  });

  it('resolves an opaque ref across separate Core RPC calls', async () => {
    const path = 'clips/MCP設計.md';
    const markdown = [
      '---',
      'source_url: "https://example.com/mcp"',
      'title: "MCP設計"',
      '---',
      '',
      'Service Bindingのrequestをまたいで読む。',
    ].join('\n');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/search/code?') && method === 'GET') {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              path,
              sha: 'mcp-sha',
              html_url: 'https://github.com/example/clips/blob/main/mcp.md',
              repository: { full_name: 'example/clips' },
            },
          ],
        });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'GET') {
        return jsonResponse({
          sha: 'mcp-sha',
          html_url: 'https://github.com/example/clips/blob/main/mcp.md',
          encoding: 'base64',
          content: utf8ToBase64(markdown),
        });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem });
    const core = { env } as unknown as CoreMcpEntrypoint;
    const audit = { source: 'mcp' as const, subject: 'subject' };

    const found = await CoreMcpEntrypoint.prototype.callTool.call(core, audit, {
      name: 'find_clips',
      args: { query: 'MCP設計' },
    });
    const foundItems = 'found' in found && Array.isArray(found.found) ? found.found : [];
    const clipRef = foundItems[0]?.clip_ref;
    expect(clipRef).toEqual(expect.any(String));

    const read = await CoreMcpEntrypoint.prototype.callTool.call(core, audit, {
      name: 'read_clip',
      args: { clip_ref: clipRef },
    });
    expect(read).toMatchObject({
      found: true,
      clip_ref: clipRef,
      path,
      body: 'Service Bindingのrequestをまたいで読む。',
    });
  });

  it('rejects an invalid audit context before rendering the clip page', async () => {
    const env = makeEnv();
    await expect(
      CoreMcpEntrypoint.prototype.renderClipPage.call({ env } as unknown as CoreMcpEntrypoint, {
        source: 'web',
        subject: '',
      }),
    ).rejects.toThrow('invalid audit context');
  });

  it('renders the clip page from D1 without going through the tool contract', async () => {
    const env = makeEnv();
    await recordClip(env, {
      path: 'clips/公開境界.md',
      url: 'https://example.com/edge',
      title: '公開境界',
      excerpt: 'Edgeは認証と受け渡しだけを持つ。',
      clippedAt: '2026-08-24T00:00:00.000Z',
    });

    const html = await CoreMcpEntrypoint.prototype.renderClipPage.call(
      { env } as unknown as CoreMcpEntrypoint,
      { source: 'web', subject: 'access-user-123' },
    );

    expect(html).toContain('<a href="https://example.com/edge">公開境界</a>');
    expect(html).toContain('Edgeは認証と受け渡しだけを持つ。');
    expect(html).toContain('保存 1件 · まだ片付けていない 1件');
  });
});
