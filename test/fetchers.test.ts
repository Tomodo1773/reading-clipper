import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContent } from '../src/fetchers';
import { makeEnv } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('source fetchers', () => {
  it('fetches Qiita from its Markdown endpoint', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# TypeScriptの話\n\n本文', { status: 200 }),
    );
    const result = await fetchContent('https://qiita.com/alice/items/abc', makeEnv());
    expect(spy.mock.calls[0]?.[0].toString()).toBe('https://qiita.com/alice/items/abc.md');
    expect(result).toMatchObject({ source: 'qiita', title: 'TypeScriptの話', author: 'alice' });
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
    expect(requestBody).toMatchObject({ formats: ['markdown'], onlyMainContent: true, maxAge: 0 });
  });
});
