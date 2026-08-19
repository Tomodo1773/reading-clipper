import type { Env } from './types';

/** 1回のダイジェストで出す件数。保存量に連動させない（ADR 0010）。 */
const DIGEST_SIZE = 7;

/** 1回の検索で返す件数の上限。結果はモデルの文脈に入るので、全件は返さない（ADR 0016）。 */
const SEARCH_SIZE = 8;

/** 台帳の1行のうち、読み出す用途によらず要る部分。 */
export interface ClipRow {
  path: string;
  /** 記事のcanonical URL。NULLの行はGitHubのファイルへリンクする。 */
  url: string | null;
  /** 記事タイトル。NULLならパス末尾から導出する（ADR 0011）。 */
  title: string | null;
  clippedAt: string;
}

/** 週次ダイジェストに出す1件。表示に使う列を余分に読む（ADR 0011）。 */
export interface DigestClip extends ClipRow {
  excerpt: string | null;
  imageUrl: string | null;
}

/** 検索で見つけたクリップ。片付いているかどうかも返す（ADR 0016）。 */
export interface FoundClip extends ClipRow {
  dismissedAt: string | null;
}

/**
 * その行をどの題名で呼ぶか。
 *
 * ADR 0005でファイル名を記事タイトルそのものにしたので、`title`が無い行（バックフィル由来）
 * でもパスから読める題名が取れる。ただし長い題名はファイル名にした時点で削られている。
 */
export function clipTitle(clip: ClipRow): string {
  if (clip.title) return clip.title;
  return (clip.path.split('/').pop() ?? clip.path).replace(/\.md$/, '');
}

/** 保存時に台帳へ書く値。表示に使うものはここで複製する（ADR 0011）。 */
export interface ClipRecord {
  path: string;
  url: string;
  title: string;
  excerpt: string;
  imageUrl?: string;
  clippedAt: string;
}

/**
 * 保存したクリップを台帳へ記録する。
 *
 * 同じ記事を保存し直しても`last_shown_at`と`dismissed_at`は残す。
 * `INSERT OR REPLACE`は行ごと置き換えるため、片付けた印が黙って消える。
 *
 * 表示に使う列は取り直した値で上書きする。ここに足し忘れると、記事が更新されても
 * 古いタイトルや抜粋がダイジェストに出続ける。`clipped_at`だけは最初の保存時のままにする。
 */
export async function recordClip(env: Env, clip: ClipRecord): Promise<void> {
  await env.CLIPS.prepare(
    `INSERT INTO clips (path, url, title, excerpt, image_url, clipped_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         excerpt = excluded.excerpt,
         image_url = excluded.image_url`,
  )
    .bind(clip.path, clip.url, clip.title, clip.excerpt, clip.imageUrl ?? null, clip.clippedAt)
    .run();
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * 次のダイジェストに出す7件を選ぶ。
 *
 * `last_shown_at ASC`はSQLiteがNULLを先頭へ置くため、未提示が最優先になる。
 * その中を`clipped_at DESC`にすることで、昨日保存した記事が在庫の後ろで
 * 飢餓状態にならない（ADR 0010）。閾値も調整パラメータも持たない。
 */
export async function selectDigestClips(env: Env): Promise<DigestClip[]> {
  const { results } = await env.CLIPS.prepare(
    `SELECT path, url, title, excerpt, image_url AS imageUrl, clipped_at AS clippedAt
       FROM clips
      WHERE dismissed_at IS NULL
      ORDER BY last_shown_at ASC, clipped_at DESC
      LIMIT ?`,
  )
    .bind(DIGEST_SIZE)
    .all<DigestClip>();
  return results;
}

/**
 * 提示済みの印を打つ。
 *
 * 選んだ時点ではなく、Slackへ投稿できてから呼ぶ。cronは再試行されないので、
 * 先に打つと投稿に失敗した週の7件が、一度も出ないまま順番の後ろへ回る。
 */
export async function markDigestShown(env: Env, paths: string[], shownAt: string): Promise<void> {
  if (paths.length === 0) return;
  await env.CLIPS.prepare(
    `UPDATE clips SET last_shown_at = ? WHERE path IN (${placeholders(paths.length)})`,
  )
    .bind(shownAt, ...paths)
    .run();
}

/** 渡したパスのうち、まだ片付いていないものを返す。 */
export async function selectUndismissed(env: Env, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const { results } = await env.CLIPS.prepare(
    `SELECT path FROM clips
      WHERE dismissed_at IS NULL AND path IN (${placeholders(paths.length)})`,
  )
    .bind(...paths)
    .all<{ path: string }>();
  return new Set(results.map((row) => row.path));
}

/**
 * 片付けた印を立てる、または外す。戻り値はそのパスが台帳にあったかどうか。
 *
 * 二度押しは同じ状態を書き直すだけなので、専用の冪等キーを持たない。
 */
export async function setClipDismissed(
  env: Env,
  path: string,
  dismissed: boolean,
  at: string,
): Promise<boolean> {
  const { meta } = await env.CLIPS.prepare('UPDATE clips SET dismissed_at = ? WHERE path = ?')
    .bind(dismissed ? at : null, path)
    .run();
  return meta.changes > 0;
}

/**
 * LIKEのメタ文字を打ち消す。素通しにすると`%`1文字で全件一致になる。
 * エスケープ文字自身も対象に含める。含めないと、語に混じった`\`が後続の1文字を無効にする。
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * 題名・URL・パスの部分一致でクリップを探す（ADR 0016）。
 *
 * 片付け済みも返す。ダイジェストの母集団と違い、片付けたつもりのゴミを
 * 後から消したくなる場面があるため、`dismissed_at`では絞らない。
 *
 * `title`がNULLの行（バックフィル由来）があるので、パスも一致の対象にする。
 * 全文検索の索引は持たない。個人利用の規模では部分一致1本で足りる。
 */
export async function findClips(env: Env, query: string): Promise<FoundClip[]> {
  const pattern = `%${escapeLike(query)}%`;
  const { results } = await env.CLIPS.prepare(
    `SELECT path, title, url, clipped_at AS clippedAt, dismissed_at AS dismissedAt
       FROM clips
      WHERE title LIKE ? ESCAPE '\\'
         OR url LIKE ? ESCAPE '\\'
         OR path LIKE ? ESCAPE '\\'
      ORDER BY clipped_at DESC
      LIMIT ?`,
  )
    .bind(pattern, pattern, pattern, SEARCH_SIZE)
    .all<FoundClip>();
  return results;
}

/**
 * 台帳から行ごと消す（ADR 0016）。
 *
 * 片付けの印とは別で、保存そのものを無かったことにする操作の片割れである。
 * もう片方のGitHubのファイルを先に消してから呼ぶ。戻り値はそのパスが台帳にあったかどうか。
 */
export async function deleteClip(env: Env, path: string): Promise<boolean> {
  const { meta } = await env.CLIPS.prepare('DELETE FROM clips WHERE path = ?').bind(path).run();
  return meta.changes > 0;
}
