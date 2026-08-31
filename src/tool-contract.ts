import { z } from 'zod';

/** BotとMCP Edgeが共有する、transport非依存のtool contract。 */
export const coreToolSchemas = {
  load_content: z.object({ url: z.string().url().describe('読み込む記事のHTTP(S) URL。') }),
  save_loaded: z.object({
    loaded_ref: z.string().min(1).describe('load_contentが返したopaqueなloaded_ref。'),
    body_language: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .optional()
      .describe('保存する本文の言語（BCP 47の言語コード。日本語ならja、英語ならen）。'),
  }),
  set_clip_dismissed: z.object({
    path: z.string().startsWith('clips/').describe('clips/ から始まるクリップのパス。'),
    dismissed: z.boolean().describe('片付けるならtrue、印を外すならfalse。'),
  }),
  find_clips: z.object({
    query: z.string().trim().min(1).max(120).describe('題名・URL・本文に含まれる検索語。'),
  }),
  list_clips: z.object({
    title_query: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('題名に含まれる語。空白区切りで全部を含むものに絞る。省略すると全件が対象。'),
  }),
  read_clip: z.object({
    clip_ref: z.string().min(1).describe('find_clipsまたはlist_clipsが返したopaqueなclip_ref。'),
  }),
  delete_clip: z.object({
    clip_ref: z.string().min(1).describe('find_clipsまたはlist_clipsが返したopaqueなclip_ref。'),
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
  load_content:
    'URLの中身を読み込み、全文とopaqueなloaded_refを返す。保存はしない。リダイレクトは自動で追う。',
  save_loaded:
    'load_contentが返したloaded_refの本文snapshotを再取得せずGitHubへ保存する。未発行・期限切れrefは拒否する。body_languageが日本語以外なら、保存の後で本文を日本語へ置き換える翻訳が非同期で走る。渡さないと翻訳しない。',
  set_clip_dismissed:
    'D1に実在する保存済みクリップへ「片付けた」印を付ける、または外す。1回につき1件。',
  find_clips:
    '保存済みクリップを本文から最大5件探し、読取・削除に使うopaqueなclip_refを返す。GitHubのコード検索索引に依存するため、0件は保存されていないことの根拠にならない。題名で在否を確かめるときはlist_clipsを使う。',
  list_clips:
    '保存済みクリップをGitHubのファイル一覧から直接引く。検索索引を経由しないので、matchedが返っていれば全件を走査した結果である。title_queryを省略すると全件が対象。matchedが0なら、その題名のクリップは保存されていない。該当が100件を超えるときは項目を返さずtoo_manyを返すので、語を足して絞る。長い題名はファイル名が255バイトで切り詰められるため、末尾の語では引けないことがある。本文は見ないのでsnippetとgithub_urlは返さない。',
  read_clip:
    'find_clipsまたはlist_clipsが返したclip_refの現在の本文をGitHubから読む。検索snippetだけを本文の根拠にしない。保存時の素性も返す。fetch_completeがfalseなら本文は取り切れていないので、そのつもりで扱う。',
  delete_clip:
    'find_clipsまたはlist_clipsが返したclip_refのクリップ1件をGitHubとD1から削除する。Git履歴から復元できる。',
};
