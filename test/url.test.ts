import { describe, expect, it } from 'vitest';
import { buildClipPath, canonicalizeUrl, classifyUrl, extractUrls } from '../src/url';

describe('URL handling', () => {
  it('extracts Slack links and keeps only unique URLs', () => {
    expect(
      extractUrls('読む <https://example.com/a?x=1|Example> と https://example.com/a?x=1。'),
    ).toEqual(['https://example.com/a?x=1']);
  });

  it('keeps URL path characters while removing sentence punctuation', () => {
    expect(extractUrls('https://example.com/a(foo) https://example.com/a[ref].')).toEqual([
      'https://example.com/a(foo)',
      'https://example.com/a[ref]',
    ]);
  });

  it('canonicalizes known sources without tracking query strings', () => {
    const x = canonicalizeUrl('http://twitter.com/user/status/123?utm_source=x#part');
    expect(x.toString()).toBe('https://x.com/i/web/status/123');
    expect(classifyUrl(x)).toBe('x');

    const qiita = canonicalizeUrl('https://www.qiita.com/u/items/abc/?x=1');
    expect(qiita.toString()).toBe('https://qiita.com/u/items/abc');
    expect(classifyUrl(qiita)).toBe('qiita');

    const zenn = canonicalizeUrl('http://www.zenn.dev/alice/articles/abc123def456/?utm_source=s');
    expect(zenn.toString()).toBe('https://zenn.dev/alice/articles/abc123def456');
    expect(classifyUrl(zenn)).toBe('zenn');

    expect(
      canonicalizeUrl('https://x.com/user/status/123/photo/1?ref=share').toString(),
    ).toBe('https://x.com/i/web/status/123');
    expect(canonicalizeUrl('http://example.com/a#part').toString()).toBe(
      'http://example.com/a',
    );
  });

  it('treats only Zenn articles as a Zenn source', () => {
    // publicationの記事もユーザーの記事と同じ `/{name}/articles/{slug}` になる。
    expect(classifyUrl(canonicalizeUrl('https://zenn.dev/estie/articles/64b80da2fbf175'))).toBe(
      'zenn',
    );
    expect(canonicalizeUrl('https://zenn.dev/alice/articles/abc123def456.md').toString()).toBe(
      'https://zenn.dev/alice/articles/abc123def456',
    );
    for (const raw of [
      'https://zenn.dev/alice/books/my-book',
      'https://zenn.dev/alice/books/my-book/viewer/chapter1',
      'https://zenn.dev/alice/scraps/abc123def456',
      'https://zenn.dev/alice',
      'https://zenn.dev/topics/typescript',
      'https://zenn.dev/articles/abc123def456',
      'https://example.com/alice/articles/abc123def456',
    ]) {
      expect(classifyUrl(canonicalizeUrl(raw))).toBe('web');
    }
  });

  it('uses a deterministic, readable GitHub path', async () => {
    const path = await buildClipPath('https://example.com/articles/testing');
    expect(path).toMatch(/^clips\/example\.com\/articles-testing-[a-f0-9]{16}\.md$/);
    expect(await buildClipPath('https://example.com/articles/testing')).toBe(path);
  });

  it('builds a path for an URL containing invalid percent encoding', async () => {
    await expect(buildClipPath('https://example.com/a%ZZ')).resolves.toMatch(
      /^clips\/example\.com\/a-zz-[a-f0-9]{16}\.md$/,
    );
  });
});
