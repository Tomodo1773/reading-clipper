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
