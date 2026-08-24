import { z } from 'zod';

/** BotとMCP Edgeが共有する、transport非依存のtool contract。 */
export const coreToolSchemas = {
  load_content: z.object({ url: z.string().url().describe('読み込む記事のHTTP(S) URL。') }),
  save_loaded: z.object({
    loaded_ref: z.string().min(1).describe('load_contentが返したopaqueなloaded_ref。'),
  }),
  set_clip_dismissed: z.object({
    path: z.string().startsWith('clips/').describe('clips/ から始まるクリップのパス。'),
    dismissed: z.boolean().describe('片付けるならtrue、印を外すならfalse。'),
  }),
  find_clips: z.object({
    query: z.string().trim().min(1).max(120).describe('題名・URL・本文に含まれる検索語。'),
  }),
  read_clip: z.object({
    clip_ref: z.string().min(1).describe('find_clipsが返したopaqueなclip_ref。'),
  }),
  delete_clip: z.object({
    clip_ref: z.string().min(1).describe('find_clipsが返したopaqueなclip_ref。'),
  }),
} as const;

export type CoreToolName = keyof typeof coreToolSchemas;

export const coreToolNames = [
  'load_content',
  'save_loaded',
  'find_clips',
  'read_clip',
  'delete_clip',
  'set_clip_dismissed',
] as const satisfies readonly CoreToolName[];

export const coreToolDescriptions: Record<CoreToolName, string> = {
  load_content:
    'URLの中身を読み込み、全文とopaqueなloaded_refを返す。保存はしない。リダイレクトは自動で追う。',
  save_loaded:
    'load_contentが返したloaded_refの本文snapshotを再取得せずGitHubへ保存する。未発行・期限切れrefは拒否する。',
  set_clip_dismissed:
    'D1に実在する保存済みクリップへ「片付けた」印を付ける、または外す。1回につき1件。',
  find_clips:
    '保存済みクリップを題名・URL・本文から最大5件探し、読取・削除に使うopaqueなclip_refを返す。',
  read_clip:
    'find_clipsが返したclip_refの現在の本文をGitHubから読む。検索snippetだけを本文の根拠にしない。',
  delete_clip:
    'find_clipsが返したclip_refのクリップ1件をGitHubとD1から削除する。Git履歴から復元できる。',
};
