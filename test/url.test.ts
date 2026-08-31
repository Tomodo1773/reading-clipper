import { describe, expect, it } from 'vitest';
import { buildClipPath, canonicalizeUrl, classifyUrl, clipNameMatches } from '../src/url';

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

  it('points every arXiv representation at the versionless abs page', () => {
    // `abs`が論文の識別で、`html`と`pdf`はその表現。版を落とすのはarXiv自身が
    // `link rel="canonical"`で版無しのURLを指しているため（ADR 0024）。
    for (const raw of [
      'https://arxiv.org/abs/2608.18300',
      'https://arxiv.org/abs/2608.18300v2',
      'https://arxiv.org/html/2608.18300v2',
      'https://arxiv.org/pdf/2608.18300',
      'https://arxiv.org/pdf/2608.18300v1.pdf',
      'http://www.arxiv.org/abs/2608.18300/?utm_source=s',
    ]) {
      const url = canonicalizeUrl(raw);
      expect(classifyUrl(url)).toBe('arxiv');
      expect(url.toString()).toBe('https://arxiv.org/abs/2608.18300');
    }

    // 旧形式のIDはパスにスラッシュを含む。今も現役のURLなので落とさない。
    expect(canonicalizeUrl('https://arxiv.org/abs/hep-th/9108001v3').toString()).toBe(
      'https://arxiv.org/abs/hep-th/9108001',
    );
    expect(canonicalizeUrl('https://arxiv.org/pdf/math.AG/0611234').toString()).toBe(
      'https://arxiv.org/abs/math.AG/0611234',
    );

    for (const raw of [
      'https://arxiv.org/list/cs.AI/recent',
      'https://arxiv.org/abs/not-an-id',
      'https://export.arxiv.org/abs/2608.18300',
      'https://example.com/abs/2608.18300',
    ]) {
      expect(classifyUrl(canonicalizeUrl(raw))).toBe('web');
    }
  });

  it('treats only Speaker Deck talk pages as a slide source', () => {
    const talk = canonicalizeUrl('https://www.speakerdeck.com/alice/my-talk/?utm_source=s');
    expect(talk.toString()).toBe('https://speakerdeck.com/alice/my-talk');
    expect(classifyUrl(talk)).toBe('speakerdeck');

    for (const raw of [
      // 発表ページと同じ`/{1}/{2}`の形をした、Speaker Deck自身のページ。
      'https://speakerdeck.com/c/technology',
      'https://speakerdeck.com/p/featured',
      'https://speakerdeck.com/s/featured',
      'https://speakerdeck.com/features/slide-notes',
      'https://speakerdeck.com/pro/storyboard-artists',
      'https://speakerdeck.com/player/95a650e6159848709be4289c31bbf5f2',
      // ユーザーのページは発表ではない。
      'https://speakerdeck.com/alice',
      'https://speakerdeck.com/alice/my-talk/extra',
    ]) {
      expect(classifyUrl(canonicalizeUrl(raw))).toBe('web');
    }
  });

  it('treats only Docswell slide pages as a slide source', () => {
    // `www`無しでも開けるが、ドクセル自身は`og:url`と構造化データで`www`付きを名乗る。
    const slide = canonicalizeUrl('http://docswell.com/s/alice/ZN7NJ2-my-slide/?utm_source=s');
    expect(slide.toString()).toBe('https://www.docswell.com/s/alice/ZN7NJ2-my-slide');
    expect(classifyUrl(slide)).toBe('docswell');

    for (const raw of [
      'https://www.docswell.com/user/alice',
      'https://www.docswell.com/category/programming',
      'https://www.docswell.com/s/alice',
      'https://www.docswell.com/slide/ZN7NJ2/embed',
    ]) {
      expect(classifyUrl(canonicalizeUrl(raw))).toBe('web');
    }
  });

  it('names the file after the article title, flat under clips/', () => {
    expect(buildClipPath('Cloudflare Workersの設計')).toBe('clips/Cloudflare-Workersの設計.md');
    // 日本語も大文字小文字もそのまま残す。ローマ字化や小文字化はしない。
    expect(buildClipPath('TypeScript入門 Part1')).toBe('clips/TypeScript入門-Part1.md');
  });

  it('removes characters that break file names on Windows', () => {
    expect(buildClipPath('A<B>C:D"E/F\\G|H?I*JK')).toBe('clips/A-B-C-D-E-F-G-H-I-JK.md');
    // 制御文字も落とす。
    expect(buildClipPath('A\nB\u0000C')).toBe('clips/A-B-C.md');
    // 先頭のドットは隠しファイル化し、末尾のドットと空白はWindowsで壊れる。
    expect(buildClipPath('  ...gitignoreの話... ')).toBe('clips/gitignoreの話.md');
    // 連続する空白は`-`1つにまとめる。
    expect(buildClipPath('A  -  B\tC')).toBe('clips/A-B-C.md');
  });

  it('avoids Windows reserved device names, extension included', () => {
    expect(buildClipPath('CON')).toBe('clips/CON_.md');
    expect(buildClipPath('com1.log')).toBe('clips/com1_.log.md');
    // 予約語で始まるだけの名前は予約されないため、そのまま残す。
    expect(buildClipPath('CONTENT')).toBe('clips/CONTENT.md');
  });

  it('reserves README.md for the folder README, not an article', () => {
    expect(buildClipPath('README')).toBe('clips/README-clip.md');
    expect(buildClipPath('readme')).toBe('clips/readme-clip.md');
    expect(buildClipPath('README.md')).toBe('clips/README.md.md');
  });

  it('keeps each path segment within 255 bytes without splitting characters', () => {
    const fileName = buildClipPath('あ'.repeat(200)).split('/').at(-1)!;
    const bytes = new TextEncoder().encode(fileName).length;
    expect(bytes).toBeLessThanOrEqual(255);
    // 3バイト文字を途中で切っていないこと（252 / 3 = 84文字）。
    expect(fileName).toBe(`${'あ'.repeat(84)}.md`);

    const surrogate = buildClipPath('𩸽'.repeat(100)).split('/').at(-1)!;
    expect(new TextEncoder().encode(surrogate).length).toBeLessThanOrEqual(255);
    expect(surrogate).toBe(`${'𩸽'.repeat(63)}.md`);
    expect(surrogate).not.toContain('�');
  });

  it('falls back when the title leaves nothing usable', () => {
    expect(buildClipPath('  ///  ')).toBe('clips/untitled.md');
  });
});

// 保存済みの実データをそのまま固定値にする。抽象的な正規化テストでは、題名とファイル名で
// 記号が食い違う穴（保存済み39件中9件が該当）を見つけられない（ADR 0031）。
describe('clipNameMatches', () => {
  const mercari = 'clips/AI-Native-な開発の実践に向けて-メルカリエンジニアリング.md';
  const kunpe =
    'clips/AIに会社の地図を持たせたら、3年目社員のように働き始めた-〜精度とトークン効率を上げるオントロジーの実践〜｜kunpe-(ymdpharm).md';
  const hatamasa = 'clips/会議でメンバーが黙るのは、当事者意識の問題ではない｜hatamasa.md';
  const tanstack =
    'clips/TanStack-Start-+-Hono-+-oRPC-+-Cloudflare-Workersで社内ERPを作った設計と学び.md';

  it('matches a title whose ASCII separator the file name had to drop', () => {
    // `makeClipFileName`が`|`を空白へ落として`-`へ畳むため、本物の題名とは記号が違う。
    expect(clipNameMatches(mercari, 'AI-Native な開発の実践に向けて | メルカリエンジニアリング')).toBe(
      true,
    );
  });

  it('matches across the wave dash and the full-width pipe, which NFKC alone leaves apart', () => {
    // `〜`(U+301C)は`～`(U+FF5E)へ正規化されない。記号を区切りへ落とすことで吸収する。
    expect(
      clipNameMatches(
        kunpe,
        'AIに会社の地図を持たせたら、3年目社員のように働き始めた 〜精度とトークン効率を上げるオントロジーの実践〜｜kunpe (ymdpharm)',
      ),
    ).toBe(true);
    expect(clipNameMatches(kunpe, 'kunpe ymdpharm')).toBe(true);
  });

  it('matches the title that the code search index could not find', () => {
    expect(clipNameMatches(hatamasa, '会議でメンバーが黙るのは、当事者意識の問題ではない｜hatamasa')).toBe(
      true,
    );
    expect(clipNameMatches(hatamasa, '会議 黙る')).toBe(true);
    expect(clipNameMatches(hatamasa, 'hatamasa')).toBe(true);
  });

  it('treats hyphens, spaces and plus signs alike, and ignores case', () => {
    expect(clipNameMatches(tanstack, 'tanstack start hono')).toBe(true);
    expect(clipNameMatches(tanstack, 'TanStack-Start')).toBe(true);
  });

  it('requires every term, so an unrelated word rules the clip out', () => {
    expect(clipNameMatches(mercari, 'メルカリ TiDB')).toBe(false);
    expect(clipNameMatches(hatamasa, '当事者意識 給与')).toBe(false);
  });

  it('matches everything when there is no query, so listing shares the path', () => {
    expect(clipNameMatches(hatamasa, '')).toBe(true);
    expect(clipNameMatches(hatamasa, '   ')).toBe(true);
  });
});
