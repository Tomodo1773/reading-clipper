import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreMcpEntrypoint } from '../src/core-rpc';
import { recordClip, setClipDismissed } from '../src/clips';
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
      CoreMcpEntrypoint.prototype.clipPage.call({ env } as unknown as CoreMcpEntrypoint, {
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

    // 片付けの印はD1で別名にして読む。ここまで通して、2段への振り分けを確かめる。
    await recordClip(env, {
      path: 'clips/読み終えた記事.md',
      url: 'https://example.com/done',
      title: '読み終えた記事',
      excerpt: '片付けた側の抜粋',
      clippedAt: '2026-08-23T00:00:00.000Z',
    });
    await setClipDismissed(env, 'clips/読み終えた記事.md', true, '2026-08-25T00:00:00.000Z');

    const html = await CoreMcpEntrypoint.prototype.clipPage.call(
      { env } as unknown as CoreMcpEntrypoint,
      { source: 'web', subject: 'access-user-123' },
    );

    expect(html).toContain('<a href="https://example.com/edge">公開境界</a>');
    expect(html).toContain('Edgeは認証と受け渡しだけを持つ。');
    expect(html).toContain('まだ片付けていない（1件）');
    expect(html).toContain('片付けたもの（1件）');
    expect(html).toContain('<a href="https://example.com/done">読み終えた記事</a>');
    // 片付けた側は取りに来る面なので、抜粋を出さない。
    expect(html).not.toContain('片付けた側の抜粋');
  });
});

describe('list_clips', () => {
  const audit = { source: 'mcp' as const, subject: 'subject' };

  function mockTree(fileNames: string[], options: { fail?: boolean } = {}) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' }, 201);
      }
      if (url.pathname.endsWith('/git/trees/HEAD:clips')) {
        if (options.fail) return jsonResponse({ message: 'Bad credentials' }, 401);
        return jsonResponse({
          truncated: false,
          tree: fileNames.map((path) => ({ path, type: 'blob', sha: path })),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem });
    return { env, core: { env } as unknown as CoreMcpEntrypoint };
  }

  function call(core: CoreMcpEntrypoint, args: unknown) {
    return CoreMcpEntrypoint.prototype.callTool.call(core, audit, { name: 'list_clips', args });
  }

  it('lists every clip newest first, keeping the ones D1 never recorded', async () => {
    const { env, core } = mockTree(['古い記事.md', '新しい記事.md', '台帳に無い記事.md']);
    await recordClip(env, {
      path: 'clips/古い記事.md',
      url: 'https://example.com/old',
      title: '古い記事',
      excerpt: '',
      clippedAt: '2026-08-01T00:00:00.000Z',
    });
    await recordClip(env, {
      path: 'clips/新しい記事.md',
      url: 'https://example.com/new',
      title: '新しい記事',
      excerpt: '',
      clippedAt: '2026-08-20T00:00:00.000Z',
    });

    const result = await call(core, {});
    expect(result).toMatchObject({ matched: 3 });
    const found = 'found' in result && Array.isArray(result.found) ? result.found : [];
    // 台帳に行が無いクリップも母集団から落とさない。順序は`clipped_at DESC, path ASC`。
    expect(found.map((clip) => clip.path)).toEqual([
      'clips/新しい記事.md',
      'clips/古い記事.md',
      'clips/台帳に無い記事.md',
    ]);
    expect(found[2]).toMatchObject({ title: '台帳に無い記事', dismissed: null });
    expect(found[0]).toMatchObject({ url: 'https://example.com/new', dismissed: false });
    // 本文を見ていないので、検索と違いsnippetとgithub_urlは持たない。
    expect(found[0]?.snippet).toBeUndefined();
    expect(found[0]?.github_url).toBeUndefined();
    expect(found[0]?.clip_ref).toEqual(expect.any(String));
  });

  it('finds the clip by its title even though the code search index is not consulted', async () => {
    const { core } = mockTree([
      '会議でメンバーが黙るのは、当事者意識の問題ではない｜hatamasa.md',
      'AI時代の強いチームの作り方.md',
    ]);
    const result = await call(core, { title_query: '会議 黙る' });
    expect(result).toMatchObject({ matched: 1 });
    const found = 'found' in result && Array.isArray(result.found) ? result.found : [];
    expect(found[0]?.path).toBe('clips/会議でメンバーが黙るのは、当事者意識の問題ではない｜hatamasa.md');
  });

  it('reports a scanned zero, which is a fact that the clip is not saved', async () => {
    const { core } = mockTree(['AI時代の強いチームの作り方.md']);
    const result = await call(core, { title_query: '存在しない題名' });
    expect(result).toEqual({ found: [], matched: 0 });
    expect(result).not.toHaveProperty('failed_at');
  });

  it('still returns the items when the match count sits exactly on the limit', async () => {
    // 境界を`>`で判定している。`>=`にすると、ちょうど上限のときに黙って項目が消える。
    const { core } = mockTree(Array.from({ length: 100 }, (_, index) => `記事${index}.md`));
    const result = await call(core, {});
    expect(result).toMatchObject({ matched: 100 });
    expect('found' in result && Array.isArray(result.found) ? result.found : []).toHaveLength(100);
    expect(result).not.toHaveProperty('too_many');
  });

  it('breaks a tie on clipped_at by path, so the order never depends on tree order', async () => {
    const { env, core } = mockTree(['ロ.md', 'イ.md']);
    for (const path of ['clips/ロ.md', 'clips/イ.md']) {
      await recordClip(env, {
        path,
        url: `https://example.com/${encodeURIComponent(path)}`,
        title: path,
        excerpt: '',
        clippedAt: '2026-08-20T00:00:00.000Z',
      });
    }

    const result = await call(core, {});
    const found = 'found' in result && Array.isArray(result.found) ? result.found : [];
    expect(found.map((clip) => clip.path)).toEqual(['clips/イ.md', 'clips/ロ.md']);
  });

  it('returns the count instead of an arbitrary slice when too many match', async () => {
    const { core } = mockTree(Array.from({ length: 101 }, (_, index) => `記事${index}.md`));
    expect(await call(core, {})).toEqual({ found: [], matched: 101, too_many: true });
  });

  it('omits the count when the tree could not be read, so zero is never implied', async () => {
    const { core } = mockTree([], { fail: true });
    const result = await call(core, {});
    expect(result).toEqual({ found: [], failed_at: 'github' });
    expect(result).not.toHaveProperty('matched');
  });
});
