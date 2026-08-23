import { describe, expect, it } from 'vitest';
import { parseClipFrontMatter, splitFrontMatter } from '../src/front-matter';
import { renderClipMarkdown } from '../src/markdown';

describe('splitFrontMatter', () => {
  it('reads only the first block', () => {
    const { fields, body } = splitFrontMatter(
      ['---', 'title: 外側', '---', '', '---', 'title: 本文側', '---', '', '本文。'].join('\n'),
    );
    expect(fields.title).toBe('外側');
    expect(body).toContain('title: 本文側');
  });

  it('returns the whole source when there is no front matter', () => {
    expect(splitFrontMatter('# 見出し\n\n本文。')).toEqual({ fields: {}, body: '# 見出し\n\n本文。' });
  });
});

describe('parseClipFrontMatter', () => {
  it('round-trips what renderClipMarkdown wrote', () => {
    const source = renderClipMarkdown(
      {
        canonicalUrl: 'https://example.com/a',
        source: 'web',
        title: 'コロン: を含む "題名"',
        markdown: '# 見出し\n\n本文。',
        complete: true,
      },
      '2026-08-15T00:00:00.000Z',
    );
    const { fields, body } = parseClipFrontMatter(source);
    expect(fields.source_url).toBe('https://example.com/a');
    expect(fields.title).toBe('コロン: を含む "題名"');
    expect(fields.clipped_at).toBe('2026-08-15T00:00:00.000Z');
    expect(body.trim()).toBe('# 見出し\n\n本文。');
  });

  it('keeps a broken quoted value raw', () => {
    expect(parseClipFrontMatter('---\ntitle: "壊れた\n---\n本文。').fields.title).toBe('"壊れた');
  });
});
