import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreMcpEntrypoint, CoreWebEntrypoint } from '../src/core-rpc';
import { recordClip, setClipDismissed } from '../src/clips';
import { resetGitHubTokenCache } from '../src/github';
import { utf8ToBase64 } from '../src/utils';
import type { Env } from '../src/types';
import { generatePrivateKeyPem, jsonResponse, makeEnv, resetClips } from './helpers';

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  await resetClips();
  privateKeyPem = await generatePrivateKeyPem();
});

afterEach(() => vi.restoreAllMocks());

describe('Core MCP RPC', () => {
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

    const found = await CoreMcpEntrypoint.prototype.callTool.call(core, {
      name: 'find_clips',
      args: { query: 'MCP設計' },
    });
    const foundItems = 'found' in found && Array.isArray(found.found) ? found.found : [];
    const clipRef = foundItems[0]?.clip_ref;
    expect(clipRef).toEqual(expect.any(String));

    const read = await CoreMcpEntrypoint.prototype.callTool.call(core, {
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
});

describe('Core Web RPC', () => {
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

    const html = await CoreWebEntrypoint.prototype.clipPage.call(
      { env } as unknown as CoreWebEntrypoint,
    );

    expect(html).toContain(
      '<a href="https://example.com/edge" target="_blank" rel="noreferrer">公開境界</a>',
    );
    expect(html).toContain('Edgeは認証と受け渡しだけを持つ。');
    expect(html).toContain('まだ片付けていない（1件）');
    expect(html).toContain('片付けたもの（1件）');
    expect(html).toContain(
      '<a href="https://example.com/done" target="_blank" rel="noreferrer">読み終えた記事</a>',
    );
    // 片付けた側は取りに来る面なので、抜粋を出さない。
    expect(html).not.toContain('片付けた側の抜粋');
  });

  it('dismisses one clip through the window the web boundary is given', async () => {
    const env = makeEnv();
    await recordClip(env, {
      path: 'clips/読まないと決めた.md',
      url: 'https://example.com/skip',
      title: '読まないと決めた',
      excerpt: '',
      clippedAt: '2026-09-02T00:00:00.000Z',
    });
    const core = { env } as unknown as CoreWebEntrypoint;

    expect(await CoreWebEntrypoint.prototype.dismissClip.call(core, 'clips/読まないと決めた.md'))
      .toEqual({ updated: true, path: 'clips/読まないと決めた.md', dismissed: true });
    // 台帳に無いパスは、印の付けようがないことをそのまま返す。
    expect(await CoreWebEntrypoint.prototype.dismissClip.call(core, 'clips/無い.md')).toEqual({
      updated: false,
      unknown_path: 'clips/無い.md',
    });
  });
});

describe('list_clips', () => {
  function mockTree(fileNames: string[], options: { fail?: boolean; failD1?: boolean } = {}) {
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
    const brokenClips = {
      prepare() {
        throw new Error('D1 is unavailable');
      },
    } as unknown as D1Database;
    const env = makeEnv({
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      ...(options.failD1 ? { CLIPS: brokenClips } : {}),
    });
    return { env, core: { env } as unknown as CoreMcpEntrypoint };
  }

  function foundPaths(result: unknown): string[] {
    const found =
      result && typeof result === 'object' && 'found' in result && Array.isArray(result.found)
        ? (result.found as Array<{ path: string }>)
        : [];
    return found.map((clip) => clip.path);
  }

  async function recordAt(env: Env, path: string, clippedAt: string) {
    await recordClip(env, {
      path,
      url: `https://example.com/${encodeURIComponent(path)}`,
      title: path,
      excerpt: '',
      clippedAt,
    });
  }

  function call(core: CoreMcpEntrypoint, args: unknown) {
    return CoreMcpEntrypoint.prototype.callTool.call(core, { name: 'list_clips', args });
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

  it('returns the newest slice with the full count when more than the limit match', async () => {
    const names = Array.from({ length: 101 }, (_, index) => `記事${index}.md`);
    const { env, core } = mockTree(names);
    // 記事100が最も古い。既定の上限では、それだけが溢れる。
    for (const [index, name] of names.entries()) {
      await recordAt(env, `clips/${name}`, new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString());
    }

    const result = await call(core, {});
    expect(result).toMatchObject({ matched: 101 });
    expect(result).not.toHaveProperty('too_many');
    const paths = foundPaths(result);
    expect(paths).toHaveLength(100);
    expect(paths[0]).toBe('clips/記事0.md');
    expect(paths).not.toContain('clips/記事100.md');
  });

  it('returns only the newest ones when a limit is given', async () => {
    const { env, core } = mockTree(['古い.md', '中間.md', '新しい.md']);
    await recordAt(env, 'clips/古い.md', '2026-08-01T00:00:00.000Z');
    await recordAt(env, 'clips/中間.md', '2026-08-10T00:00:00.000Z');
    await recordAt(env, 'clips/新しい.md', '2026-08-20T00:00:00.000Z');

    const result = await call(core, { limit: 2 });
    expect(result).toMatchObject({ matched: 3 });
    expect(foundPaths(result)).toEqual(['clips/新しい.md', 'clips/中間.md']);
  });

  it('filters by the dismissed mark, counting a clip D1 never recorded as not dismissed', async () => {
    const { env, core } = mockTree(['片付けた.md', '読んでいない.md', '台帳に無い記事.md']);
    await recordAt(env, 'clips/片付けた.md', '2026-08-20T00:00:00.000Z');
    await recordAt(env, 'clips/読んでいない.md', '2026-08-10T00:00:00.000Z');
    await setClipDismissed(env, 'clips/片付けた.md', true, '2026-08-21T00:00:00.000Z');

    const open = await call(core, { dismissed: false });
    expect(open).toMatchObject({ matched: 2 });
    expect(foundPaths(open)).toEqual(['clips/読んでいない.md', 'clips/台帳に無い記事.md']);

    const done = await call(core, { dismissed: true });
    expect(done).toMatchObject({ matched: 1 });
    expect(foundPaths(done)).toEqual(['clips/片付けた.md']);
  });

  it('still answers a title lookup when D1 is down and every match fits', async () => {
    const { core } = mockTree(['ロ.md', 'イ.md'], { failD1: true });
    const result = await call(core, {});
    expect(result).toMatchObject({ matched: 2 });
    expect(foundPaths(result)).toEqual(['clips/イ.md', 'clips/ロ.md']);
  });

  it('fails instead of claiming an order or a dismissed state it could not read', async () => {
    const { core } = mockTree(['ロ.md', 'イ.md'], { failD1: true });
    for (const args of [{ limit: 1 }, { dismissed: false }]) {
      const result = await call(core, args);
      expect(result).toEqual({ found: [], failed_at: 'clips' });
      expect(result).not.toHaveProperty('matched');
    }
  });

  it('omits the count when the tree could not be read, so zero is never implied', async () => {
    const { core } = mockTree([], { fail: true });
    const result = await call(core, {});
    expect(result).toEqual({ found: [], failed_at: 'github' });
    expect(result).not.toHaveProperty('matched');
  });
});

describe('clip read page', () => {
  function core() {
    return { env: makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }) } as unknown as CoreWebEntrypoint;
  }

  it('renders the saved body as HTML, with the front matter dropped', async () => {
    const markdown = `---
source_url: "https://example.com/en"
title: "Attention Is All You Need"
translated_at: "2026-09-01T00:00:00.000Z"
---

## 概要

日本語へ置き換えた本文。`;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/contents/')) {
        return jsonResponse({
          sha: 'sha',
          html_url: 'https://github.com/example/clips/blob/main/a.md',
          encoding: 'base64',
          content: utf8ToBase64(markdown),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const html = await CoreWebEntrypoint.prototype.clipReadPage.call(
      core(),
      'clips/Attention Is All You Need.md',
    );

    expect(html).toContain('<h1>Attention Is All You Need</h1>');
    expect(html).toContain('<h2>概要</h2>');
    expect(html).toContain('<p>日本語へ置き換えた本文。</p>');
    // フロントマターは読む面に出さない。
    expect(html).not.toContain('source_url');
  });

  it('returns nothing for a clip GitHub does not have', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    });

    expect(
      await CoreWebEntrypoint.prototype.clipReadPage.call(core(), 'clips/消した記事.md'),
    ).toBeUndefined();
  });

  // パスは外から来る。保存先の外を指すものは、GitHubへ問い合わせる前に落とす。
  it('refuses a path that points outside the clips directory, without asking GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('GitHub must not be asked');
    });
    const entrypoint = core();
    const read = (path: string) => CoreWebEntrypoint.prototype.clipReadPage.call(entrypoint, path);

    expect(await read('.github/workflows/build.yml')).toBeUndefined();
    expect(await read('clips/../.github/workflows/build.yml')).toBeUndefined();
    expect(await read('')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
