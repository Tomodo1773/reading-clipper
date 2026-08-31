import { describe, expect, it } from 'vitest';
import { type ClipPageEntry, renderClipPage } from '../src/clip-page';

const entry = (overrides: Partial<ClipPageEntry> = {}): ClipPageEntry => ({
  path: 'clips/Worker 設計.md',
  url: 'https://zenn.dev/alice/articles/worker',
  title: 'Worker [設計]',
  excerpt: null,
  imageUrl: null,
  clippedAt: '2026-08-18T15:30:00.000Z',
  dismissedAt: null,
  ...overrides,
});

/**
 * 新しい順に`count`件。`clipped_at`をずらして並びを固定する。
 * `path`は台帳の主キーなので、`name`を変えて重複しない組を作る。
 */
const entries = (
  count: number,
  overrides: Partial<ClipPageEntry> = {},
  name = '記事',
): ClipPageEntry[] =>
  Array.from({ length: count }, (_, index) =>
    entry({
      path: `clips/${name}${index}.md`,
      title: `${name}${index}`,
      url: `https://zenn.dev/alice/articles/${name}${index}`,
      clippedAt: `2026-08-${String(28 - index).padStart(2, '0')}T00:00:00.000Z`,
      ...overrides,
    }),
  );

describe('renderClipPage', () => {
  const page = { repo: 'example/clips' };

  it('links the title to the article and the saved copy to GitHub', () => {
    const html = renderClipPage([entry()], page);

    expect(html).toContain('<a href="https://zenn.dev/alice/articles/worker">Worker [設計]</a>');
    expect(html).toContain(
      '<a href="https://github.com/example/clips/blob/HEAD/clips/Worker%20%E8%A8%AD%E8%A8%88.md">GitHub版</a>',
    );
    expect(html).toContain('zenn.dev · 8/19');
  });

  it('does not hand the page hostname to the sites the thumbnails come from', () => {
    const html = renderClipPage([entry({ imageUrl: 'https://img.example.com/a.png' })], page);

    expect(html).toContain(
      '<img src="https://img.example.com/a.png" alt="" loading="lazy" referrerpolicy="no-referrer">',
    );
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
      page,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('本文に&lt;b&gt;タグ&lt;/b&gt;が混じる');
    expect(html).toContain('src="https://img.example.com/a.png?a=1&amp;b=%222%22"');
  });

  it('escapes a title that came in with HTML on the dismissed side too', () => {
    const html = renderClipPage(
      [entry({ title: '<script>alert(1)</script>', dismissedAt: '2026-08-20T00:00:00.000Z' })],
      page,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('drops a thumbnail and a title link that are not http(s)', () => {
    const html = renderClipPage(
      [entry({ url: 'javascript:alert(1)', imageUrl: 'javascript:alert(1)' })],
      page,
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p class="title">Worker [設計]</p>');
  });

  // 出発点だった不具合。20件の窓で切っていた頃は、片付け済みが席を取るぶんだけ
  // 片付けていない古いクリップが一覧から落ちていた（ADR 0032）。
  it('keeps every undismissed clip, however many are saved', () => {
    const html = renderClipPage(
      [...entries(25), ...entries(5, { dismissedAt: '2026-08-29T00:00:00.000Z' }, '片付け済み')],
      page,
    );

    expect(html.match(/<li class="clip">/gu)).toHaveLength(25);
    expect(html).toContain('まだ片付けていない（25件）');
    expect(html).toContain('片付けたもの（5件）');
  });

  it('puts a dismissed clip in its own section as a single line, without a thumbnail or excerpt', () => {
    const html = renderClipPage(
      [
        entry({
          excerpt: '片付けたほうの抜粋',
          imageUrl: 'https://img.example.com/a.png',
          dismissedAt: '2026-08-20T00:00:00.000Z',
        }),
      ],
      page,
    );

    expect(html).toContain('<h2>片付けたもの（1件）</h2>');
    expect(html).toContain('<a href="https://zenn.dev/alice/articles/worker">Worker [設計]</a>');
    // 眺める面ではなく取りに来る面なので、サムネイルと抜粋は出さない。
    expect(html).not.toContain('<img');
    expect(html).not.toContain('片付けたほうの抜粋');
    // 見出しで分かれる以上、取り消し線と薄字は要らない。
    expect(html).not.toContain('dismissed');
  });

  it('says so when everything has been dismissed, and still lists the dismissed side', () => {
    const html = renderClipPage([entry({ dismissedAt: '2026-08-20T00:00:00.000Z' })], page);

    expect(html).toContain('まだ片付けていない（0件）');
    expect(html).toContain('全部片付いた。');
    expect(html).toContain('片付けたもの（1件）');
  });

  it('leaves out the dismissed section entirely while nothing has been dismissed', () => {
    const html = renderClipPage([entry()], page);

    expect(html).toContain('まだ片付けていない（1件）');
    expect(html).not.toContain('片付けたもの');
  });

  it('says so when there is nothing saved yet', () => {
    const html = renderClipPage([], page);

    expect(html).toContain('まだクリップはない。');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('<h2>');
  });
});
