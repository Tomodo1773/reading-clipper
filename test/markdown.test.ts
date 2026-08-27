import { describe, expect, it } from 'vitest';
import { renderClipMarkdown } from '../src/markdown';

const clippedAt = '2026-08-15T00:00:00.000Z';

describe('stored Markdown', () => {
  it('puts the fetched body directly under the front matter', () => {
    const markdown = renderClipMarkdown(
      {
        canonicalUrl: 'https://example.com/a',
        source: 'web',
        title: 'Example',
        author: 'Alice',
        publishedAt: '2026-08-01T00:00:00.000Z',
        markdown: '\n# Example\n\n本文。\n',
        complete: false,
      },
      clippedAt,
    );

    expect(markdown).toBe(
      [
        '---',
        'source_url: "https://example.com/a"',
        'source_type: "web"',
        'title: "Example"',
        'author: "Alice"',
        'published_at: "2026-08-01T00:00:00.000Z"',
        'clipped_at: "2026-08-15T00:00:00.000Z"',
        'fetch_complete: false',
        '---',
        '',
        '# Example',
        '',
        '本文。',
        '',
      ].join('\n'),
    );
  });

  it('keeps the summary out of the saved file', () => {
    const markdown = renderClipMarkdown(
      {
        canonicalUrl: 'https://example.com/a',
        source: 'qiita',
        title: 'Example',
        markdown: '# Body',
        complete: true,
      },
      clippedAt,
    );

    expect(markdown).not.toContain('summary');
    expect(markdown).not.toContain('## 取得内容');
    // 版を持たない取得元では行ごと出ない。
    expect(markdown).not.toContain('source_version');
    expect(markdown).toBe(
      [
        '---',
        'source_url: "https://example.com/a"',
        'source_type: "qiita"',
        'title: "Example"',
        'clipped_at: "2026-08-15T00:00:00.000Z"',
        'fetch_complete: true',
        '---',
        '',
        '# Body',
        '',
      ].join('\n'),
    );
  });

  it('records which revision the arXiv body came from', () => {
    // canonical URLは版を含まないため、改版後に貼り直すと同じファイルを上書きする。
    // どの版の本文かはこの行にしか残らない（ADR 0024）。
    const markdown = renderClipMarkdown(
      {
        canonicalUrl: 'https://arxiv.org/abs/2608.18300',
        source: 'arxiv',
        title: 'A Paper About Judges',
        version: 'v2',
        markdown: '# A Paper About Judges',
        complete: true,
      },
      clippedAt,
    );

    expect(markdown).toContain('source_type: "arxiv"');
    expect(markdown).toContain('source_version: "v2"');
  });
});
