import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContent, fetchPageHead, loadContent } from '../src/fetchers';
import { htmlResponse, jsonResponse, makeEnv } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('source fetchers', () => {
  it('takes the Qiita title from the front matter, not from the first body heading', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        [
          '---',
          'title: TypeScriptの話',
          'tags: TypeScript',
          'author: alice',
          'slide: false',
          '---',
          '# 全体像',
          '',
          '本文',
        ].join('\n'),
        { status: 200 },
      ),
    );
    const result = await fetchContent('https://qiita.com/alice/items/abc', makeEnv());
    expect(spy.mock.calls[0]?.[0].toString()).toBe('https://qiita.com/alice/items/abc.md');
    expect(result).toMatchObject({ source: 'qiita', title: 'TypeScriptの話', author: 'alice' });
    // 保存時に自前のフロントマターを付けるため、Qiita側のフロントマターは残さない。
    expect(result.markdown).toBe('# 全体像\n\n本文');
  });

  it('falls back to the Qiita item id when the front matter is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# 全体像\n\n本文', { status: 200 }));
    const result = await fetchContent('https://qiita.com/alice/items/abc', makeEnv());
    expect(result).toMatchObject({ source: 'qiita', title: 'abc', author: 'alice' });
  });

  it('converts the Zenn API body_html back into Markdown', async () => {
    const bodyHtml = [
      '<p data-line="0" class="code-line">こんにちは、<a href="https://x.com/alice" target="_blank" rel="nofollow noopener noreferrer">@alice</a>です。</p>',
      '<h2 id="%E6%A7%8B%E6%88%90" data-line="2" class="code-line">',
      '<a class="header-anchor-link" href="#%E6%A7%8B%E6%88%90" aria-hidden="true"></a> 構成</h2>',
      '<table data-line="4" class="code-line"><thead><tr><th style="text-align:left">レイヤ</th><th style="text-align:left">技術</th></tr></thead><tbody><tr><td>DB</td><td>Turso</td></tr></tbody></table>',
      '<ul data-line="8" class="code-line"><li><strong>速い</strong>こと</li><li><code>pnpm</code>で入れる</li></ul>',
      '<div class="code-block-container">',
      '<div class="code-block-filename-container"><span class="code-block-filename">fooBar.js</span></div>',
      '<pre class="shiki github-dark" style="background-color:#151e2c"><code class="code-line" data-line="12"><span class="line"><span style="color:#F97583">const</span><span style="color:#E1E4E8"> a = 1 &amp;&amp; 2;</span></span>\n<span class="line"><span></span></span></code></pre></div>',
      '<aside class="msg message"><span class="msg-symbol">!</span><div class="msg-content">\n<p data-line="18" class="code-line">補足です。</p>\n</div></aside>',
      '<p data-line="20" class="code-line"><span class="embed-block zenn-embedded zenn-embedded-card"><iframe id="zenn-embedded__x" src="https://embed.zenn.studio/card" data-content="https%3A%2F%2Fexample.com" frameborder="0" loading="lazy"></iframe></span><a href="https://example.com" style="display:none" target="_blank">https://example.com</a></p>',
    ].join('\n');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          article: {
            title: 'Cloudflareで動かす',
            published_at: '2026-08-13T14:44:16.605+09:00',
            body_html: bodyHtml,
            user: { username: 'alice', name: 'Alice' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await fetchContent('https://zenn.dev/alice/articles/abc123def456', makeEnv());
    expect(spy.mock.calls[0]?.[0].toString()).toBe('https://zenn.dev/api/articles/abc123def456');
    expect(result).toMatchObject({
      source: 'zenn',
      title: 'Cloudflareで動かす',
      author: 'Alice',
      publishedAt: '2026-08-13T14:44:16.605+09:00',
      complete: true,
    });
    expect(result.markdown).toBe(
      [
        'こんにちは、[@alice](https://x.com/alice)です。',
        '',
        '## 構成',
        '',
        '| レイヤ | 技術 |',
        '| --- | --- |',
        '| DB | Turso |',
        '',
        '- **速い**こと',
        '- `pnpm`で入れる',
        '',
        '`fooBar.js`',
        '',
        '```js',
        'const a = 1 && 2;',
        '```',
        '',
        '> 補足です。',
        '',
        '[https://example.com](https://example.com)',
      ].join('\n'),
    );
  });

  it('fails the clip when the Zenn API has no article body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
    );
    await expect(
      fetchContent('https://zenn.dev/alice/articles/abc123def456', makeEnv()),
    ).rejects.toMatchObject({ stage: 'fetch', retryable: false, status: 404 });
  });

  it('prefers X Article text over the containing Post', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: '123',
            text: '記事を公開しました',
            author_id: 'u1',
            created_at: '2026-08-14T00:00:00Z',
            article: { title: '長い記事', plain_text: 'Article body' },
          },
          includes: { users: [{ id: 'u1', name: 'Alice', username: 'alice' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await fetchContent('https://x.com/alice/status/123', makeEnv());
    expect(result).toMatchObject({ source: 'x', title: '長い記事', author: '@alice' });
    expect(result.markdown).toContain('Article body');
    expect(result.markdown).not.toContain('記事を公開しました');
  });

  it('uses Firecrawl Markdown for general pages', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { markdown: '# General\n\nBody', metadata: { title: 'General', author: 'Bob' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await fetchContent('https://example.com/article', makeEnv());
    expect(result).toMatchObject({ source: 'web', title: 'General', author: 'Bob' });
    const requestBody = JSON.parse(String(spy.mock.calls[0]?.[1]?.body));
    // 依存している要件だけを送り、それ以外はFirecrawlの既定に任せる。
    expect(requestBody).toEqual({
      url: 'https://example.com/article',
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 45_000,
    });
  });

  it('fails the clip when Firecrawl scraped an error page', async () => {
    // Firecrawlは取得先が404でも`success: true`で404ページのMarkdownを返す。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { markdown: '# Not Found', metadata: { statusCode: 404, error: 'Not Found' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(fetchContent('https://example.com/missing', makeEnv())).rejects.toMatchObject({
      stage: 'fetch',
      retryable: false,
      status: 404,
    });
  });
});

/**
 * フェッチャーが叩くAPI（Zennの非公式API・Qiitaの`.md`・X API）はどれも画像を返さないため、
 * og:imageはソースで分岐せず記事ページのHTMLから取る（ADR 0011）。
 * このGETはリダイレクトの解決も兼ねる（ADR 0012）。
 */
describe('fetchPageHead', () => {
  it('takes og:image out of the head', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<meta property="og:image" content="https://cdn.example.com/a.png">'),
    );

    expect(await fetchPageHead('https://example.com/a')).toEqual({
      resolvedUrl: 'https://example.com/a',
      imageUrl: 'https://cdn.example.com/a.png',
    });
  });

  it('reports where the redirects landed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<title>題名</title>', 200, 'https://zenn.dev/alice/articles/abc123def456'),
    );

    expect(await fetchPageHead('https://share.google/tQD')).toMatchObject({
      resolvedUrl: 'https://zenn.dev/alice/articles/abc123def456',
    });
  });

  it('resolves a relative og:image against the page it landed on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<meta property="og:image" content="/img/a.png">', 200, 'https://landed.example.com/posts/a'),
    );

    expect(await fetchPageHead('https://example.com/posts/a')).toMatchObject({
      imageUrl: 'https://landed.example.com/img/a.png',
    });
  });

  it('decodes the entities that HTML attributes carry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<meta property="og:image" content="https://cdn.example.com/a?w=1&amp;h=2">'),
    );

    expect((await fetchPageHead('https://example.com/a')).imageUrl).toBe(
      'https://cdn.example.com/a?w=1&h=2',
    );
  });

  it('returns nothing when the page has no og:image', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse('<title>題名</title>'));

    expect((await fetchPageHead('https://example.com/a')).imageUrl).toBeUndefined();
  });

  // サムネイルが無くてもクリップの保存は成立する。ここで投げると保存ごと道連れになる。
  it('returns nothing instead of throwing when the page is gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse('', 404));

    expect((await fetchPageHead('https://example.com/a')).imageUrl).toBeUndefined();
  });

  // 記事ページのGETを拒否されても、着いた先が分からないまま入力URLで続行できればよい。
  it('falls back to the requested URL instead of throwing when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

    expect(await fetchPageHead('https://example.com/a')).toEqual({
      resolvedUrl: 'https://example.com/a',
    });
  });

  it('ignores an og:image that is not something Slack can fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      htmlResponse('<meta property="og:image" content="data:image/png;base64,AAAA">'),
    );

    expect((await fetchPageHead('https://example.com/a')).imageUrl).toBeUndefined();
  });
});

describe('loadContent', () => {
  /**
   * `share.google`は素のHTTPリダイレクト2段で記事本体に着く。着いてから種類を判定するので、
   * 汎用WebのFirecrawlではなくZenn専用の取り方が選ばれる（ADR 0012）。
   */
  it('classifies the page the redirects landed on, not the URL that was sent', async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === 'https://share.google/tQD') {
        return htmlResponse(
          '<meta property="og:image" content="https://cdn.example.com/z.png">',
          200,
          'https://zenn.dev/alice/articles/abc123def456',
        );
      }
      if (url.startsWith('https://zenn.dev/api/articles/')) {
        return jsonResponse({ article: { title: 'Zennの記事', body_html: '<p>本文</p>' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const content = await loadContent('https://share.google/tQD', makeEnv());

    expect(content).toMatchObject({
      source: 'zenn',
      canonicalUrl: 'https://zenn.dev/alice/articles/abc123def456',
      title: 'Zennの記事',
      imageUrl: 'https://cdn.example.com/z.png',
    });
    // Firecrawlは一度も呼ばれない。
    expect(requested.some((url) => url.includes('firecrawl'))).toBe(false);
  });

  it('rejects a URL that is not HTTP(S) before making any request', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(loadContent('ftp://example.com/a', makeEnv())).rejects.toMatchObject({
      stage: 'validation',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
