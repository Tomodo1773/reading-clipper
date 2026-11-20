import { z } from 'zod';

/**
 * `list_clips`が1回に返す件数の上限で、省略時の件数でもある（ADR 0031、ADR 0037）。
 * モデルへ渡すschemaが上限と既定値の両方にこの値を使うので、契約としてここに1つだけ置く。
 */
export const LIST_CLIPS_LIMIT = 100;

/** BotとMCP Edgeが共有する、transport非依存のtool contract。 */
export const coreToolSchemas = {
  load_content: z.object({ url: z.string().url().describe('読み込む記事のHTTP(S) URL。') }),
  save_loaded: z.object({
    loaded_ref: z.string().min(1).describe('load_contentが返したloaded_ref。'),
    body_language: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .optional()
      .describe('本文の言語コード（日本語ならja、英語ならen）。'),
  }),
  set_clip_dismissed: z.object({
    path: z.string().startsWith('clips/').describe('list_clipsまたはfind_clipsが返したpath。'),
    dismissed: z.boolean().describe('片付けるならtrue、印を外すならfalse。'),
  }),
  find_clips: z.object({
    query: z.string().trim().min(1).max(120).describe('検索語。'),
  }),
  list_clips: z.object({
    title_query: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('題名に含まれる語。空白区切りで全語を含むものに絞る。'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_CLIPS_LIMIT)
      .default(LIST_CLIPS_LIMIT)
      .describe('新しい順で返す件数。'),
    dismissed: z
      .boolean()
      .optional()
      .describe('falseなら片付けていないもの、trueなら片付けたものだけ。'),
  }),
  read_clip: z.object({
    clip_ref: z.string().min(1).describe('list_clipsまたはfind_clipsが返したclip_ref。'),
  }),
  delete_clip: z.object({
    clip_ref: z.string().min(1).describe('list_clipsまたはfind_clipsが返したclip_ref。'),
  }),
} as const;

export type CoreToolName = keyof typeof coreToolSchemas;

export const coreToolNames = [
  'load_content',
  'save_loaded',
  'list_clips',
  'find_clips',
  'read_clip',
  'delete_clip',
  'set_clip_dismissed',
] as const satisfies readonly CoreToolName[];

export const coreToolDescriptions: Record<CoreToolName, string> = {
  load_content: 'URLの中身を読み込み、全文とloaded_refを返す。保存はしない。リダイレクトは自動で追う。',
  save_loaded:
    'load_contentで読んだ本文をGitHubへ保存する。body_languageに日本語以外を渡すと、保存後に本文が日本語へ翻訳される。',
  set_clip_dismissed: '保存済みクリップに「片付けた」印を付ける、または外す。クリップは消えない。',
  find_clips:
    '保存済みクリップを、本文・題名・URLに出てくる語で最大5件探す。list_clipsで見つからないときに使う。検索索引に依存するため、0件でも保存されていないとは限らない。',
  list_clips:
    '保存済みクリップを探すときに最初に使う。新しい順に返す。題名に語が出ていそうならtitle_queryで絞り、そうでなければ絞らずに取って題名から選ぶ。matchedは条件に合う総数で、0なら保存されていない。foundがmatchedより少なければ続きがあるので、語かdismissedで絞る。',
  read_clip: 'clip_refのクリップの現在の本文を読む。find_clipsのsnippetだけを内容の根拠にしない。',
  delete_clip: 'clip_refのクリップ1件を削除する。Git履歴から復元できる。',
};
