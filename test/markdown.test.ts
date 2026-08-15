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
});
