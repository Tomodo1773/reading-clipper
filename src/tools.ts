import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { asClipError } from './errors';
import { fetchContent } from './fetchers';
import { getGitHubFile, putGitHubFile } from './github';
import { renderClipMarkdown } from './markdown';
import type { Env } from './types';
import { buildClipPath, canonicalizeUrl } from './url';

/**
 * 保存の成否は`saved`だけで表し、散文にしない。
 * 本文はトークン節約のために切り詰めない。取得時点で`MAX_CONTENT_CHARS`が効いている（ADR 0006）。
 */
async function saveClip(env: Env, rawUrl: string, receivedAt: string) {
  const canonicalUrl = canonicalizeUrl(rawUrl).toString();
  // 保存先は記事タイトルから決めるため、取得を先に行う。
  const content = await fetchContent(canonicalUrl, env);
  const path = buildClipPath(canonicalUrl, content.title);
  // 既存ファイルの更新にはshaが要る。同じタイトルの記事は上書きする。
  const existing = await getGitHubFile(env, path);
  const saved = await putGitHubFile(env, path, renderClipMarkdown(content, receivedAt), existing?.sha);
  return {
    saved: true,
    path,
    github_url: saved.htmlUrl,
    title: content.title,
    source: content.source,
    canonical_url: content.canonicalUrl,
    fetch_complete: content.complete,
    body: content.markdown,
  };
}

/**
 * モデルに渡すツール。
 *
 * 失敗はすべてツール結果として返し、モデルにその事実を伝えさせる（ADR 0008）。
 * 例外を投げてもAI SDKがツールエラーに変えてループを続けるため、Queueの再試行には乗らない。
 */
export function createTools(env: Env, receivedAt: string, google: GoogleGenerativeAIProvider) {
  return {
    /**
     * Web検索。Geminiがサーバー側で実行して結果を同じ応答に織り込むため、AI SDKのstepを消費しない。
     * キー名は`google_search`に揃える（`@ai-sdk/google`のドキュメントがそう求めている。
     * 実行時は`tool.id`で解決されるので、キー名を変えても送信内容は変わらない）。
     * `save_clip`との併用はGemini 3世代でのみ成立する。2.x以下では`functionDeclarations`が
     * warningだけ出して落ちる（`wrangler.jsonc`の`AI_MODEL`を参照）。
     */
    google_search: google.tools.googleSearch({}),
    save_clip: tool({
      description: [
        'URLの記事を取得してMarkdownに整え、ユーザーのGitHubリポジトリへ保存する。',
        '「あとで読む」ために取っておきたいURLを渡されたときに使う。',
        '取得した本文をそのまま返すので、保存した記事について要約したり質問に答えたりするときは、',
        '別の手段を取らずにこのツールの結果を読むこと。',
        '既に保存済みのURLをもう一度渡すと、取得し直して同じ場所を上書きする。',
      ].join(''),
      inputSchema: z.object({
        url: z.string().describe('保存する記事のHTTP(S) URL。1回につき1件。'),
      }),
      execute: async ({ url }) => {
        try {
          return await saveClip(env, url, receivedAt);
        } catch (error) {
          const clipError = asClipError(error, 'fetch');
          console.warn(
            JSON.stringify({
              stage: clipError.stage,
              status: clipError.status,
              message: clipError.message,
              tool: 'save_clip',
            }),
          );
          // どこで落ちたかはstageで足りる。散文はモデルが書く。
          return { saved: false, failed_at: clipError.stage };
        }
      },
    }),
  };
}
