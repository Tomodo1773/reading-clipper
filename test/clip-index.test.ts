import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshClipIndex } from '../src/clip-index';
import {
  CLIP_INDEX_MARKER,
  type ClipIndexEntry,
  isGeneratedClipIndex,
  renderClipIndex,
  renderClipPage,
} from '../src/clip-index-format';
import { recordClip } from '../src/clips';
import { resetGitHubTokenCache } from '../src/github';
import { setClipDismissedTool } from '../src/tools';
import { base64ToUtf8, utf8ToBase64 } from '../src/utils';
import {
  generatePrivateKeyPem,
  jsonResponse,
  makeEnv,
  resetClips,
} from './helpers';

const entry = (overrides: Partial<ClipIndexEntry> = {}): ClipIndexEntry => ({
  path: 'clips/Worker 設計.md',
  url: 'https://zenn.dev/alice/articles/worker',
  title: 'Worker [設計]',
  excerpt: null,
  imageUrl: null,
  clippedAt: '2026-08-18T15:30:00.000Z',
  dismissedAt: null,
  ...overrides,
});

/** 新しい順に`count`件。`clipped_at`をずらして並びを固定する。 */
const entries = (count: number, overrides: Partial<ClipIndexEntry> = {}): ClipIndexEntry[] =>
  Array.from({ length: count }, (_, index) =>
    entry({
      path: `clips/記事${index}.md`,
      title: `記事${index}`,
      url: `https://zenn.dev/alice/articles/${index}`,
      clippedAt: `2026-08-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`,
      ...overrides,
    }),
  );

const counts = (total: number, undismissed: number) => ({ total, undismissed });

beforeEach(async () => {
  vi.restoreAllMocks();
  resetGitHubTokenCache();
  await resetClips();
});

describe('renderClipIndex', () => {
  it('renders the newest undismissed clip as a card with an escaped title and host', () => {
    expect(renderClipIndex([entry()], counts(1, 1))).toBe(
      `${CLIP_INDEX_MARKER}\n` +
        '# Clips\n\n' +
        '保存 1件 · まだ片付けていない 1件\n\n' +
        '## 最近のクリップ\n\n' +
        '**[Worker \\[設計\\]](<https://zenn.dev/alice/articles/worker>)**\n' +
        '\n' +
        '`zenn.dev` · 8/19 · [GitHub版](<./Worker%20%E8%A8%AD%E8%A8%88.md>)\n',
    );
  });

  it('stacks the OGP image above the title, without a table', () => {
    const rendered = renderClipIndex(
      [entry({ imageUrl: 'https://example.com/ogp.png', excerpt: '本文の冒頭。' })],
      counts(1, 1),
    );

    expect(rendered).toContain(
      '<img src="https://example.com/ogp.png" width="320" alt="">\n\n**[Worker',
    );
    expect(rendered).toContain('本文の冒頭。');
    expect(rendered).not.toContain('<table>');
  });

  it('drops an image whose URL is not http(s)', () => {
    const rendered = renderClipIndex(
      [entry({ imageUrl: 'javascript:alert(1)' })],
      counts(1, 1),
    );

    expect(rendered).not.toContain('<img');
    expect(rendered).not.toContain('javascript:');
  });

  it('escapes markup that came from the article body', () => {
    const rendered = renderClipIndex(
      [entry({ title: '<script>alert(1)</script>', excerpt: '使い方は <b>太字</b> と & 記号' })],
      counts(1, 1),
    );

    expect(rendered).toContain('使い方は &lt;b&gt;太字&lt;/b&gt; と &amp; 記号');
    expect(rendered).toContain('&lt;script&gt;');
    expect(rendered).not.toContain('<b>');
  });

  it('fills the card slots with undismissed clips and pushes the rest into the list', () => {
    const recent = entries(7).map((item, index) =>
      index === 1 ? { ...item, dismissedAt: '2026-08-21T00:00:00.000Z' } : item,
    );

    const rendered = renderClipIndex(recent, counts(7, 6));
    const cards = rendered.slice(
      rendered.indexOf('## 最近のクリップ'),
      rendered.indexOf('## それ以前'),
    );
    const list = rendered.slice(rendered.indexOf('## それ以前'));

    // 片付けた記事1はカードに入らず、6番目の記事5が繰り上がる。
    expect(cards).toContain('記事0');
    expect(cards).not.toContain('記事1');
    expect(cards).toContain('記事5');
    expect(cards).not.toContain('記事6');
    // 箇条書きは元の並び順のまま。片付けたものだけ取り消し線で消す。
    expect(list).toContain(
      '- 8/19 · ~~[記事1](<https://zenn.dev/alice/articles/1>)~~ · zenn.dev · [GitHub版](<./%E8%A8%98%E4%BA%8B1.md>)',
    );
    expect(list).toContain(
      '- 8/14 · [記事6](<https://zenn.dev/alice/articles/6>) · zenn.dev · [GitHub版](<./%E8%A8%98%E4%BA%8B6.md>)',
    );
  });

  it('omits the card section when every recent clip is dismissed', () => {
    const rendered = renderClipIndex(
      entries(3, { dismissedAt: '2026-08-21T00:00:00.000Z' }),
      counts(3, 0),
    );

    expect(rendered).not.toContain('## 最近のクリップ');
    // 対比する相手がいないので、箇条書き側の見出しも出さない。
    expect(rendered).not.toContain('## それ以前');
    expect(rendered).toContain('~~[記事0](<https://zenn.dev/alice/articles/0>)~~');
  });

  it('renders old entries with invalid optional metadata as plain titles', () => {
    const rendered = renderClipIndex(
      [
        entry({
          path: 'clips/qiita.com/記事 (1).md',
          url: 'not a URL',
          title: '記事 (1)',
          clippedAt: 'invalid',
        }),
      ],
      counts(1, 1),
    );

    expect(rendered).toContain('**記事 (1)**');
    expect(rendered).not.toContain('not a URL');
    expect(rendered).toContain(
      '[GitHub版](<./qiita.com/%E8%A8%98%E4%BA%8B%20(1).md>)',
    );
  });

  it('counts the whole shelf, not just the clips it shows', () => {
    expect(renderClipIndex([entry()], counts(132, 41))).toContain(
      '保存 132件 · まだ片付けていない 41件',
    );
  });

  it('renders an explicit empty state', () => {
    const rendered = renderClipIndex([], counts(0, 0));

    expect(rendered).toContain('まだクリップはない。');
    expect(rendered).toContain('保存 0件 · まだ片付けていない 0件');
  });
});

describe('isGeneratedClipIndex', () => {
  it('excludes only the marked clips/README.md from backfill', () => {
    expect(isGeneratedClipIndex('clips/README.md', `${CLIP_INDEX_MARKER}\n# Clips`)).toBe(true);
    expect(isGeneratedClipIndex('clips/README.md', '# 手書きREADME')).toBe(false);
    expect(isGeneratedClipIndex('clips/archive/README.md', CLIP_INDEX_MARKER)).toBe(false);
  });
});

describe('refreshClipIndex', () => {
  async function envWithKey() {
    return makeEnv({ GITHUB_APP_PRIVATE_KEY: await generatePrivateKeyPem() });
  }

  async function seedClip(): Promise<void> {
    await recordClip(makeEnv(), {
      path: 'clips/Worker設計.md',
      url: 'https://zenn.dev/alice/articles/worker',
      title: 'Worker設計',
      excerpt: 'Queueで分ける。',
      clippedAt: '2026-08-18T15:30:00.000Z',
    });
  }

  it('creates the generated README from D1', async () => {
    await seedClip();
    let written = '';
    let message = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { content: string; message: string };
        written = base64ToUtf8(body.content);
        message = body.message;
        return jsonResponse(
          { content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/clips/README.md' } },
          201,
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await refreshClipIndex(await envWithKey());

    expect(written).toContain(CLIP_INDEX_MARKER);
    expect(written).toContain(
      '[Worker設計](<https://zenn.dev/alice/articles/worker>)',
    );
    expect(message).toBe('Add clip index');
  });

  it('does not overwrite an unmanaged README', async () => {
    let putCalled = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (method === 'GET') {
        return jsonResponse({
          sha: 'manual-sha',
          html_url: 'https://github.com/example/clips/blob/main/clips/README.md',
          encoding: 'base64',
          content: utf8ToBase64('# 手書きREADME'),
        });
      }
      putCalled = true;
      return jsonResponse({});
    });

    await expect(refreshClipIndex(await envWithKey())).rejects.toThrow('not managed');
    expect(putCalled).toBe(false);
  });

  it('rewrites the index when the agent tool dismisses a clip', async () => {
    // 片付けの入口はボタンとツールの2つあるが、一覧の作り直しまでが1つの操作である（ADR 0023）。
    await seedClip();
    const written: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.endsWith('/contents/clips/README.md') && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { content: string };
        written.push(base64ToUtf8(body.content));
        return jsonResponse({ content: { sha: 'sha', html_url: 'https://example.com/x' } }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const result = await setClipDismissedTool(await envWithKey(), '2026-08-20T00:00:00.000Z', {
      path: 'clips/Worker設計.md',
      dismissed: true,
    });

    expect(result).toEqual({ updated: true, path: 'clips/Worker設計.md', dismissed: true });
    expect(written).toHaveLength(1);
    expect(written[0]!).toContain('~~[Worker設計](');
  });

  it('leaves the index alone when the tool dismisses a path D1 does not have', async () => {
    let requests = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      requests += 1;
      return jsonResponse({});
    });

    const result = await setClipDismissedTool(await envWithKey(), '2026-08-20T00:00:00.000Z', {
      path: 'clips/存在しない.md',
      dismissed: true,
    });

    expect(result).toEqual({ updated: false, unknown_path: 'clips/存在しない.md' });
    expect(requests).toBe(0);
  });

  it('refetches the SHA and retries once after a 409', async () => {
    let gets = 0;
    let puts = 0;
    const usedShas: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (method === 'GET') {
        gets += 1;
        return jsonResponse({
          sha: `sha-${gets}`,
          html_url: 'https://github.com/example/clips/blob/main/clips/README.md',
          encoding: 'base64',
          content: utf8ToBase64(`${CLIP_INDEX_MARKER}\n# Clips\n`),
        });
      }
      puts += 1;
      usedShas.push((JSON.parse(String(init?.body)) as { sha: string }).sha);
      return puts === 1
        ? jsonResponse({ message: 'conflict' }, 409)
        : jsonResponse({ content: { sha: 'done', html_url: 'https://example.com/index' } });
    });

    await refreshClipIndex(await envWithKey());

    expect(gets).toBe(2);
    expect(puts).toBe(2);
    expect(usedShas).toEqual(['sha-1', 'sha-2']);
  });
});

describe('renderClipPage', () => {
  const page = { repo: 'example/clips' };

  it('links the title to the article and the saved copy to GitHub', () => {
    const html = renderClipPage([entry()], counts(1, 1), page);

    expect(html).toContain('<a href="https://zenn.dev/alice/articles/worker">Worker [設計]</a>');
    expect(html).toContain(
      '<a href="https://github.com/example/clips/blob/HEAD/clips/Worker%20%E8%A8%AD%E8%A8%88.md">GitHub版</a>',
    );
    expect(html).toContain('zenn.dev · 8/19');
    expect(html).toContain('保存 1件 · まだ片付けていない 1件');
  });

  it('escapes HTML that came in with the excerpt, title and image URL', () => {
    const html = renderClipPage(
      [
        entry({
          title: '<script>alert(1)</script>',
          excerpt: '本文に<b>タグ</b>が混じる',
          imageUrl: 'https://img.example.com/a.png?a=1&b="2"',
        }),
      ],
      counts(1, 1),
      page,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('本文に&lt;b&gt;タグ&lt;/b&gt;が混じる');
    expect(html).toContain('src="https://img.example.com/a.png?a=1&amp;b=%222%22"');
  });

  it('drops a thumbnail and a title link that are not http(s)', () => {
    const html = renderClipPage(
      [entry({ url: 'javascript:alert(1)', imageUrl: 'javascript:alert(1)' })],
      counts(1, 1),
      page,
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p class="title">Worker [設計]</p>');
  });

  it('keeps a dismissed clip in place and marks it instead of hiding it', () => {
    const html = renderClipPage(
      [entry({ dismissedAt: '2026-08-20T00:00:00.000Z' })],
      counts(1, 0),
      page,
    );

    expect(html).toContain('<li class="clip dismissed">');
    expect(html).toContain('<a href="https://zenn.dev/alice/articles/worker">Worker [設計]</a>');
  });

  it('lists every clip in one run, without the Markdown card split', () => {
    const html = renderClipPage(entries(20), counts(20, 20), page);

    expect(html.match(/<li class="clip/gu)).toHaveLength(20);
    expect(html).not.toContain('最近のクリップ');
    expect(html).not.toContain('それ以前');
  });

  it('says so when there is nothing saved yet', () => {
    const html = renderClipPage([], counts(0, 0), page);

    expect(html).toContain('まだクリップはない。');
    expect(html).not.toContain('<li');
  });
});
