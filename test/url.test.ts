import { describe, expect, it } from 'vitest';
import { buildClipPath, canonicalizeUrl, classifyUrl } from '../src/url';

describe('URL handling', () => {
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

  it('names the file after the article title, under the host directory', () => {
    expect(buildClipPath('https://example.com/articles/1', 'Cloudflare Workersの設計')).toBe(
      'clips/example.com/Cloudflare-Workersの設計.md',
    );
    // 日本語も大文字小文字もそのまま残す。ローマ字化や小文字化はしない。
    expect(buildClipPath('https://qiita.com/u/items/abc', 'TypeScript入門 Part1')).toBe(
      'clips/qiita.com/TypeScript入門-Part1.md',
    );
  });

  it('removes characters that break file names on Windows', () => {
    expect(
      buildClipPath('https://example.com/a', 'A<B>C:D"E/F\\G|H?I*JK'),
    ).toBe('clips/example.com/A-B-C-D-E-F-G-H-I-JK.md');
    // 制御文字も落とす。
    expect(buildClipPath('https://example.com/a', 'A\nB\u0000C')).toBe(
      'clips/example.com/A-B-C.md',
    );
    // 先頭のドットは隠しファイル化し、末尾のドットと空白はWindowsで壊れる。
    expect(buildClipPath('https://example.com/a', '  ...gitignoreの話... ')).toBe(
      'clips/example.com/gitignoreの話.md',
    );
    // 連続する空白は`-`1つにまとめる。
    expect(buildClipPath('https://example.com/a', 'A  -  B\tC')).toBe(
      'clips/example.com/A-B-C.md',
    );
  });

  it('avoids Windows reserved device names, extension included', () => {
    expect(buildClipPath('https://example.com/a', 'CON')).toBe('clips/example.com/CON_.md');
    expect(buildClipPath('https://example.com/a', 'com1.log')).toBe(
      'clips/example.com/com1_.log.md',
    );
    // 予約語で始まるだけの名前は予約されないため、そのまま残す。
    expect(buildClipPath('https://example.com/a', 'CONTENT')).toBe(
      'clips/example.com/CONTENT.md',
    );
  });

  it('keeps each path segment within 255 bytes without splitting characters', () => {
    const fileName = buildClipPath('https://example.com/a', 'あ'.repeat(200)).split('/').at(-1)!;
    const bytes = new TextEncoder().encode(fileName).length;
    expect(bytes).toBeLessThanOrEqual(255);
    // 3バイト文字を途中で切っていないこと（252 / 3 = 84文字）。
    expect(fileName).toBe(`${'あ'.repeat(84)}.md`);

    const surrogate = buildClipPath('https://example.com/a', '𩸽'.repeat(100)).split('/').at(-1)!;
    expect(new TextEncoder().encode(surrogate).length).toBeLessThanOrEqual(255);
    expect(surrogate).toBe(`${'𩸽'.repeat(63)}.md`);
    expect(surrogate).not.toContain('�');
  });

  it('falls back when the title leaves nothing usable', () => {
    expect(buildClipPath('https://example.com/a', '  ///  ')).toBe(
      'clips/example.com/untitled.md',
    );
  });
});
