import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  markDigestShown,
  recordClip,
  selectDigestClips,
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
      path: 'clips/qiita.com/記事.md',
      url: 'https://qiita.com/a/items/1',
      title: '古いタイトル',
      excerpt: '古い抜粋',
      imageUrl: 'https://img.example.com/old.png',
      clippedAt: '2026-08-01T00:00:00.000Z',
    });
    await setClipDismissed(env, 'clips/qiita.com/記事.md', true, '2026-08-02T00:00:00.000Z');

    await recordClip(env, {
      path: 'clips/qiita.com/記事.md',
      url: 'https://qiita.com/a/items/2',
      title: '新しいタイトル',
      excerpt: '新しい抜粋',
      imageUrl: 'https://img.example.com/new.png',
      clippedAt: '2026-08-03T00:00:00.000Z',
    });

    expect(await readClip('clips/qiita.com/記事.md')).toMatchObject({
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
      path: 'clips/x.com/画像の無い記事.md',
      url: 'https://x.com/i/web/status/1',
      title: '画像の無い記事',
      excerpt: '抜粋',
      clippedAt: '2026-08-01T00:00:00.000Z',
    });

    expect((await readClip('clips/x.com/画像の無い記事.md'))?.image_url).toBeNull();
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

  it('returns exactly seven clips however many are waiting', async () => {
    await seed(
      Array.from({ length: 9 }, (_unused, index) => ({
        path: `clips/${index}.md`,
        clippedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      })),
    );

    expect(await selectDigestClips(env)).toHaveLength(7);
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
