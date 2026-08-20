import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clipTitle,
  deleteClip,
  findClips,
  markDigestShown,
  recordClip,
  selectDigestClips,
  selectRecentClips,
  selectUndismissed,
  setClipDismissed,
} from '../src/clips';
import { makeEnv, resetClips } from './helpers';

const env = makeEnv();

interface ClipRow {
  path: string;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  image_url: string | null;
  clipped_at: string;
  last_shown_at: string | null;
  dismissed_at: string | null;
}

function readClip(path: string): Promise<ClipRow | null> {
  return testEnv.CLIPS.prepare('SELECT * FROM clips WHERE path = ?').bind(path).first<ClipRow>();
}

async function seed(
  rows: Array<{ path: string; clippedAt: string; lastShownAt?: string; dismissedAt?: string }>,
): Promise<void> {
  for (const row of rows) {
    await testEnv.CLIPS.prepare(
      'INSERT INTO clips (path, url, clipped_at, last_shown_at, dismissed_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(
        row.path,
        `https://example.com/${row.path}`,
        row.clippedAt,
        row.lastShownAt ?? null,
        row.dismissedAt ?? null,
      )
      .run();
  }
}

beforeEach(resetClips);

describe('recordClip', () => {
  it('refreshes what the digest shows but keeps the dismissed mark', async () => {
    // `INSERT OR REPLACE`を使うと行ごと入れ替わり、片付けた印が黙って消える。
    await recordClip(env, {
      path: 'clips/記事.md',
      url: 'https://qiita.com/a/items/1',
      title: '古いタイトル',
      excerpt: '古い抜粋',
      imageUrl: 'https://img.example.com/old.png',
      clippedAt: '2026-08-01T00:00:00.000Z',
    });
    await setClipDismissed(env, 'clips/記事.md', true, '2026-08-02T00:00:00.000Z');

    await recordClip(env, {
      path: 'clips/記事.md',
      url: 'https://qiita.com/a/items/2',
      title: '新しいタイトル',
      excerpt: '新しい抜粋',
      imageUrl: 'https://img.example.com/new.png',
      clippedAt: '2026-08-03T00:00:00.000Z',
    });

    expect(await readClip('clips/記事.md')).toMatchObject({
      url: 'https://qiita.com/a/items/2',
      // ここを更新し忘れると、記事が変わっても古い表示がダイジェストに残り続ける。
      title: '新しいタイトル',
      excerpt: '新しい抜粋',
      image_url: 'https://img.example.com/new.png',
      // 最初に保存した時刻のまま。保存し直しは新しいクリップではない。
      clipped_at: '2026-08-01T00:00:00.000Z',
      dismissed_at: '2026-08-02T00:00:00.000Z',
    });
  });

  it('stores a clip without an og:image as NULL rather than failing', async () => {
    await recordClip(env, {
      path: 'clips/画像の無い記事.md',
      url: 'https://x.com/i/web/status/1',
      title: '画像の無い記事',
      excerpt: '抜粋',
      clippedAt: '2026-08-01T00:00:00.000Z',
    });

    expect((await readClip('clips/画像の無い記事.md'))?.image_url).toBeNull();
  });
});

describe('selectDigestClips', () => {
  it('puts never-shown clips first, newest first, so new saves do not starve', async () => {
    // shown_countで並べると初回に最も古い7件が出て、昨日保存した記事が何週間も出てこない（ADR 0010）。
    await seed([
      { path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z' },
      { path: 'clips/b.md', clippedAt: '2026-08-10T00:00:00.000Z' },
      { path: 'clips/c.md', clippedAt: '2026-08-15T00:00:00.000Z', lastShownAt: '2026-08-05T00:00:00.000Z' },
      { path: 'clips/d.md', clippedAt: '2026-08-12T00:00:00.000Z', lastShownAt: '2026-08-01T00:00:00.000Z' },
      { path: 'clips/gone.md', clippedAt: '2026-08-14T00:00:00.000Z', dismissedAt: '2026-08-16T00:00:00.000Z' },
    ]);

    const clips = await selectDigestClips(env);

    expect(clips.map((clip) => clip.path)).toEqual([
      'clips/b.md',
      'clips/a.md',
      'clips/d.md',
      'clips/c.md',
    ]);
  });

  it('caps the candidates however many are waiting', async () => {
    // 返すのは出す7件ではなく候補10件（ADR 0018）。GitHubから消えた行を落としたあとに
    // 7件を保つための余りで、7件へ切るのはダイジェスト側。
    await seed(
      Array.from({ length: 14 }, (_unused, index) => ({
        path: `clips/${index}.md`,
        clippedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      })),
    );

    expect(await selectDigestClips(env)).toHaveLength(10);
  });
});

describe('markDigestShown', () => {
  it('stamps only the clips it was given', async () => {
    await seed([
      { path: 'clips/shown.md', clippedAt: '2026-08-01T00:00:00.000Z' },
      { path: 'clips/other.md', clippedAt: '2026-08-02T00:00:00.000Z' },
    ]);

    await markDigestShown(env, ['clips/shown.md'], '2026-08-17T00:00:00.000Z');

    expect((await readClip('clips/shown.md'))?.last_shown_at).toBe('2026-08-17T00:00:00.000Z');
    expect((await readClip('clips/other.md'))?.last_shown_at).toBeNull();
  });
});

describe('selectUndismissed', () => {
  it('returns only the paths that are still waiting', async () => {
    await seed([
      { path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z' },
      { path: 'clips/b.md', clippedAt: '2026-08-02T00:00:00.000Z', dismissedAt: '2026-08-03T00:00:00.000Z' },
    ]);

    const alive = await selectUndismissed(env, ['clips/a.md', 'clips/b.md', 'clips/missing.md']);

    expect([...alive]).toEqual(['clips/a.md']);
  });
});

describe('setClipDismissed', () => {
  it('keeps the first mark when the button is pressed twice', async () => {
    await seed([{ path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z' }]);

    await setClipDismissed(env, 'clips/a.md', true, '2026-08-02T00:00:00.000Z');
    await setClipDismissed(env, 'clips/a.md', true, '2026-08-03T00:00:00.000Z');

    // 状態は片付いたまま。二度押しのための冪等キーは持たない。
    expect((await readClip('clips/a.md'))?.dismissed_at).not.toBeNull();
    expect(await selectDigestClips(env)).toEqual([]);
  });

  it('puts a clip back when asked to undo', async () => {
    await seed([
      { path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z', dismissedAt: '2026-08-02T00:00:00.000Z' },
    ]);

    expect(await setClipDismissed(env, 'clips/a.md', false, '2026-08-03T00:00:00.000Z')).toBe(true);
    expect((await readClip('clips/a.md'))?.dismissed_at).toBeNull();
  });

  it('still reports the clip as found when the state already matches', async () => {
    // 戻り値は「台帳にあったか」であって「値が変わったか」ではない。
    // ツールはこれを見て見当違いのパスだけを弾く。
    await seed([{ path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z' }]);

    expect(await setClipDismissed(env, 'clips/a.md', false, '2026-08-03T00:00:00.000Z')).toBe(true);
  });

  it('reports a path that is not in the ledger instead of claiming success', async () => {
    expect(await setClipDismissed(env, 'clips/does-not-exist.md', true, '2026-08-03T00:00:00.000Z')).toBe(
      false,
    );
  });
});

describe('findClips', () => {
  async function seedTitled(
    rows: Array<{ title: string; url: string; clippedAt: string }>,
  ): Promise<void> {
    for (const row of rows) {
      await recordClip(env, {
        path: `clips/${row.title}.md`,
        url: row.url,
        title: row.title,
        excerpt: '抜粋',
        clippedAt: row.clippedAt,
      });
    }
  }

  it('finds a clip by part of its title, newest first', async () => {
    await seedTitled([
      { title: 'Workerの設計', url: 'https://qiita.com/a/items/1', clippedAt: '2026-08-01T00:00:00.000Z' },
      { title: 'Workerの運用', url: 'https://zenn.dev/a/articles/2', clippedAt: '2026-08-05T00:00:00.000Z' },
      { title: 'Rustの話', url: 'https://qiita.com/a/items/3', clippedAt: '2026-08-09T00:00:00.000Z' },
    ]);

    expect((await findClips(env, 'Worker')).map((clip) => clip.title)).toEqual([
      'Workerの運用',
      'Workerの設計',
    ]);
  });

  it('finds a clip by part of its URL', async () => {
    await seedTitled([
      { title: 'Workerの設計', url: 'https://qiita.com/a/items/1', clippedAt: '2026-08-01T00:00:00.000Z' },
      { title: 'Rustの話', url: 'https://zenn.dev/a/articles/2', clippedAt: '2026-08-02T00:00:00.000Z' },
    ]);

    expect((await findClips(env, 'zenn.dev')).map((clip) => clip.title)).toEqual(['Rustの話']);
  });

  it('returns dismissed clips too, since garbage is often dismissed before it is deleted', async () => {
    await seedTitled([
      { title: 'Workerの設計', url: 'https://qiita.com/a/items/1', clippedAt: '2026-08-01T00:00:00.000Z' },
    ]);
    await setClipDismissed(env, 'clips/Workerの設計.md', true, '2026-08-02T00:00:00.000Z');

    const [found] = await findClips(env, 'Worker');

    expect(found?.dismissedAt).toBe('2026-08-02T00:00:00.000Z');
  });

  it('finds a clip with no title by its path', async () => {
    // バックフィル由来の行は`title`を持たない（ADR 0010）。
    await testEnv.CLIPS.prepare('INSERT INTO clips (path, clipped_at) VALUES (?, ?)')
      .bind('clips/題名の無い記事.md', '2026-08-01T00:00:00.000Z')
      .run();

    expect((await findClips(env, '題名の無い')).map((clip) => clip.path)).toEqual([
      'clips/題名の無い記事.md',
    ]);
  });

  it('treats LIKE wildcards as literal text instead of matching everything', async () => {
    await seedTitled([
      { title: 'Workerの設計', url: 'https://qiita.com/a/items/1', clippedAt: '2026-08-01T00:00:00.000Z' },
      { title: 'Rustの話', url: 'https://qiita.com/a/items/2', clippedAt: '2026-08-02T00:00:00.000Z' },
    ]);

    expect(await findClips(env, '%')).toEqual([]);
    expect(await findClips(env, '_')).toEqual([]);
  });

  it('caps how many clips it puts into the model context', async () => {
    await seedTitled(
      Array.from({ length: 12 }, (_unused, index) => ({
        title: `Workerの記事${index}`,
        url: `https://qiita.com/a/items/${index}`,
        clippedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      })),
    );

    expect(await findClips(env, 'Worker')).toHaveLength(8);
  });
});

describe('selectRecentClips', () => {
  it('returns at most 20 clips newest first, including dismissed clips', async () => {
    await seed(
      Array.from({ length: 22 }, (_unused, index) => ({
        path: `clips/${String(index).padStart(2, '0')}.md`,
        clippedAt: `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        ...(index === 21 ? { dismissedAt: '2026-08-23T00:00:00.000Z' } : {}),
      })),
    );

    const recent = await selectRecentClips(env);

    expect(recent).toHaveLength(20);
    expect(recent[0]?.path).toBe('clips/21.md');
    expect(recent.at(-1)?.path).toBe('clips/02.md');
  });

  it('uses the path as a stable tie breaker', async () => {
    await seed([
      { path: 'clips/b.md', clippedAt: '2026-08-01T00:00:00.000Z' },
      { path: 'clips/a.md', clippedAt: '2026-08-01T00:00:00.000Z' },
    ]);

    expect((await selectRecentClips(env)).map((clip) => clip.path)).toEqual([
      'clips/a.md',
      'clips/b.md',
    ]);
  });
});

describe('clipTitle', () => {
  // ダイジェストの行と検索の結果が、同じ題名でクリップを呼ぶための1本。
  it('reads a title out of the path when the row has none', () => {
    // バックフィル由来の行は`title`を持たない（ADR 0010）。
    expect(
      clipTitle({ path: 'clips/題名の無い記事.md', title: null, url: null, clippedAt: '' }),
    ).toBe('題名の無い記事');
  });

  it('prefers the stored title, which keeps what the file name had to drop', () => {
    expect(
      clipTitle({ path: 'clips/Worker-設計.md', title: 'Worker/設計', url: null, clippedAt: '' }),
    ).toBe('Worker/設計');
  });
});

describe('deleteClip', () => {
  it('removes the row so the clip stops appearing in the digest', async () => {
    await seed([{ path: 'clips/ゴミ.md', clippedAt: '2026-08-01T00:00:00.000Z' }]);

    expect(await deleteClip(env, 'clips/ゴミ.md')).toBe(true);
    expect(await readClip('clips/ゴミ.md')).toBeNull();
    expect(await selectDigestClips(env)).toEqual([]);
  });

  it('reports a path that is not in the ledger instead of claiming success', async () => {
    expect(await deleteClip(env, 'clips/does-not-exist.md')).toBe(false);
  });
});
