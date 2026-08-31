import type { Env } from './types';

/** 1回のダイジェストで出す件数。保存量に連動させない（ADR 0010）。 */
export const DIGEST_SIZE = 7;

/**
 * 台帳から取る候補の件数（ADR 0018）。
 *
 * 投稿の直前にGitHub上の実在を確かめて消えた行を落とすので、ちょうど7件だけ取ると
 * 落ちたぶんが埋まらない。3件までなら消えていても7件を保てる、という意味の余りである。
 * 余った候補は捨てるだけで、`last_shown_at`は出した7件にしか打たない。
 */
const DIGEST_CANDIDATES = DIGEST_SIZE + 3;

/** GitHubのclips/直下で見せる新着件数。保存総数には連動させない（ADR 0017）。 */
const RECENT_CLIP_SIZE = 20;

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
  /** 実在確認でGitHubが返した保存済みMarkdownのURL。D1には保存しない。 */
  githubUrl?: string;
}

/** 検索で見つけたクリップ。片付いているかどうかも返す（ADR 0016）。 */
export interface FoundClip extends ClipRow {
  dismissedAt: string | null;
}

/**
 * 新着一覧に出す1件。カードに使う列に加えて、取り消し線の判断に要る印まで読む（ADR 0023）。
 */
export interface RecentClip extends DigestClip {
  dismissedAt: string | null;
}

/**
 * その行をどの題名で呼ぶか。
 *
 * ADR 0005でファイル名を記事タイトルそのものにしたので、`title`が無い行（バックフィル由来）
 * でもパスから読める題名が取れる。ただし長い題名はファイル名にした時点で削られている。
 */
export function clipTitle(clip: Pick<ClipRow, 'path' | 'title'>): string {
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

/**
 * 抜粋だけを差し替える（ADR 0027）。翻訳で本文が日本語へ変わったときに呼ぶ。
 *
 * `recordClip`を通さないのは、題名とURLを触らないため。ファイル名は原題のままなので、
 * 台帳の題名だけを訳題にすると保存先と表示が食い違う。変えるのは一覧に出る抜粋だけでいい。
 */
export async function updateClipExcerpt(env: Env, path: string, excerpt: string): Promise<void> {
  await env.CLIPS.prepare('UPDATE clips SET excerpt = ? WHERE path = ?').bind(excerpt, path).run();
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * 次のダイジェストの候補を選ぶ。出す7件ではなく、少し多めの候補を返す（ADR 0018）。
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
    .bind(DIGEST_CANDIDATES)
    .all<DigestClip>();
  return results;
}

/**
 * 保存構造とは別の新着ビューを組み立てるため、片付け済みも含めて新しい順に読む。
 *
 * ここで`dismissed_at`を絞らないのはADR 0017のままである。カードへ出すか箇条書きへ
 * 落とすかは表示側の判断なので、印はそのまま渡して振り分けさせる（ADR 0023）。
 */
export async function selectRecentClips(env: Env): Promise<RecentClip[]> {
  const { results } = await env.CLIPS.prepare(
    `SELECT path, url, title, excerpt, image_url AS imageUrl, clipped_at AS clippedAt,
            dismissed_at AS dismissedAt
       FROM clips
      ORDER BY clipped_at DESC, path ASC
      LIMIT ?`,
  )
    .bind(RECENT_CLIP_SIZE)
    .all<RecentClip>();
  return results;
}

/**
 * 棚の規模と、まだ片付けていない量を数える。新着一覧の見出しに出す（ADR 0023）。
 *
 * 新着一覧は最新20件しか読まないので、全体の量はそこからは分からない。
 * 表示のためだけの集計なので、2回に分けず1クエリで取る。
 */
export async function countClips(env: Env): Promise<{ total: number; undismissed: number }> {
  const row = await env.CLIPS.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN dismissed_at IS NULL THEN 1 ELSE 0 END) AS undismissed
       FROM clips`,
  ).first<{ total: number; undismissed: number | null }>();
  // 0件のとき SUM は NULL を返す。
  return { total: row?.total ?? 0, undismissed: row?.undismissed ?? 0 };
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
 * GitHub Code Searchが返したパスへ、D1の注釈を付ける（ADR 0020）。
 *
 * 母集団と検索はGitHubが担う。D1に行が無いクリップも検索結果から落とさないため、
 * 返り値はMapにして「注釈なし」と「片付けていない」を呼び出し側が区別できるようにする。
 */
export async function selectClipsByPath(
  env: Env,
  paths: string[],
): Promise<Map<string, FoundClip>> {
  if (paths.length === 0) return new Map();
  const { results } = await env.CLIPS.prepare(
    `SELECT path, title, url, clipped_at AS clippedAt, dismissed_at AS dismissedAt
       FROM clips
      WHERE path IN (${placeholders(paths.length)})`,
  )
    .bind(...paths)
    .all<FoundClip>();
  return new Map(results.map((clip) => [clip.path, clip]));
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
