import { describe, expect, it } from 'vitest';
import { clipExcerpt } from '../src/excerpt';

describe('clipExcerpt', () => {
  it('drops the heading and the markup, leaving the text on one line', () => {
    const excerpt = clipExcerpt('# 題名\n\nこれが**本文**の`書き出し`。\n次の行。\n');

    expect(excerpt).toBe('題名 これが本文の書き出し。 次の行。');
  });

  it('keeps the label of a link and drops its URL', () => {
    expect(clipExcerpt('[SPARQL](https://example.com/sparql) は問い合わせ言語。')).toBe(
      'SPARQL は問い合わせ言語。',
    );
  });

  it('drops images and code blocks instead of quoting them', () => {
    const excerpt = clipExcerpt('![図](https://example.com/a.png)\n\n```ts\nconst a = 1;\n```\n\n本文。');

    expect(excerpt).toBe('本文。');
  });

  it('drops a front matter block that the body itself starts with', () => {
    // Qiitaのクリップは原稿ごと保存されており、本文が`---`で始まる。
    // 区切りだけ落とすと`title:`や`tags:`が抜粋の先頭に居座る。
    const excerpt = clipExcerpt('---\ntitle: 本文側の題名\ntags: セマンティックWeb\n---\n\n# 全体像\n\n用語を整理する。');

    expect(excerpt).toBe('全体像 用語を整理する。');
  });

  it('cuts at 100 characters and marks that it was cut', () => {
    const excerpt = clipExcerpt('あ'.repeat(150));

    expect(excerpt).toHaveLength(101);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('does not leave half of a surrogate pair at the cut', () => {
    // 絵文字はコード単位2つぶん。境界で切ると壊れた文字が末尾に残る。
    const excerpt = clipExcerpt('あ'.repeat(99) + '😀' + 'あ'.repeat(50));

    expect(excerpt).toBe(`${'あ'.repeat(99)}…`);
  });

  it('returns an empty string for a body that has no text', () => {
    expect(clipExcerpt('\n\n```\n\n```\n\n')).toBe('');
  });
});
