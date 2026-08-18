import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { recordClip, setClipDismissed } from './clips';
import { asClipError } from './errors';
import { clipExcerpt } from './excerpt';
import { loadContent } from './fetchers';
import { getGitHubFile, putGitHubFile } from './github';
import { renderClipMarkdown } from './markdown';
import type { Env, FetchedContent } from './types';
import { buildClipPath, canonicalizeUrl } from './url';

/**
 * ロード済みの本文を、ロードしたときのままGitHubとD1へ書く。
 *
 * 取得はしない。保存先も`source_url`も、入力されたURLではなく取得結果の`canonicalUrl`
 * （リダイレクトの着いた先）から決める（ADR 0012）。
 * 保存の成否は`saved`だけで表し、散文にしない。
 */
async function saveLoaded(env: Env, content: FetchedContent, receivedAt: string) {
  const path = buildClipPath(content.title);
  // 既存ファイルの更新にはshaが要る。同じタイトルの記事は上書きする。
  const existing = await getGitHubFile(env, path);
  const saved = await putGitHubFile(env, path, renderClipMarkdown(content, receivedAt), existing?.sha);
  // D1は台帳ではなく注釈レイヤーなので、書けなくても保存は成立させる（ADR 0010）。
  // ただしこの行が入らないと、そのクリップはダイジェストに永久に出てこない。
  try {
    await recordClip(env, {
      path,
      url: content.canonicalUrl,
      title: content.title,
      excerpt: clipExcerpt(content.markdown, content.title),
      imageUrl: content.imageUrl,
      clippedAt: receivedAt,
    });
  } catch (error) {
    const clipError = asClipError(error, 'clips');
    console.warn(JSON.stringify({ stage: clipError.stage, message: clipError.message, path }));
  }
  // 本文は返さない。会話にはロードしたときの1回だけ現れれば足りる（ADR 0012）。
  return { saved: true, path, github_url: saved.htmlUrl, title: content.title };
}

/**
 * ロード済みの本文を引く鍵。同じ記事を指す書き方の揺れを、保存側でも吸収する。
 * URLとして扱えない文字列はそのまま鍵にする。どのみち引けず、`not_loaded`になればよい。
 */
function memoKey(rawUrl: string): string {
  try {
    return canonicalizeUrl(rawUrl).toString();
  } catch {
    return rawUrl;
  }
}

/**
 * モデルに渡すツール。
 *
 * 失敗はすべてツール結果として返し、モデルにその事実を伝えさせる（ADR 0008）。
 * 例外を投げてもAI SDKがツールエラーに変えてループを続けるため、Queueの再試行には乗らない。
 */
export function createTools(env: Env, receivedAt: string, google: GoogleGenerativeAIProvider) {
  /**
   * このターンでロードした本文の置き場（ADR 0012）。
   *
   * 両ツールは同じターン・同じisolateで動くので、KVもCache APIも要らない。会話履歴と同じものを
   * Durable Objectへ二重に持つこともしない。ターンをまたぐと消えるが、その場合は`save_loaded`が
   * 拒否してAIがロードし直すだけで壊れない。
   */
  const loaded = new Map<string, FetchedContent>();

  return {
    /**
     * Web検索。Geminiがサーバー側で実行して結果を同じ応答に織り込むため、AI SDKのstepを消費しない。
     * キー名は`google_search`に揃える（`@ai-sdk/google`のドキュメントがそう求めている。
     * 実行時は`tool.id`で解決されるので、キー名を変えても送信内容は変わらない）。
     * function toolsとの併用はGemini 3世代でのみ成立する。2.x以下では`functionDeclarations`が
     * warningだけ出して落ちる（`wrangler.jsonc`の`AI_MODEL`を参照）。
     */
    google_search: google.tools.googleSearch({}),
    load_content: tool({
      description: [
        'URLの中身を読み込んで全文を返す。保存はしない。',
        'URLを渡されたら、何であれまずこのツールで読むこと。中身を見ないと、それ自体が読み物なのか、',
        '他の記事を紹介しているだけの投稿なのかは分からない。',
        'リダイレクトは自動で追うので、共有用の中継URLを渡してもよい。',
        '結果のurlが実際に読んだ記事のURLで、保存するときはこれをsave_loadedへ渡す。',
        '本文は結果に入る。要約するときも続けて聞かれたことに答えるときも、この結果を読むこと。',
      ].join(''),
      inputSchema: z.object({
        url: z.string().describe('読み込む記事のHTTP(S) URL。1回につき1件。'),
      }),
      execute: async ({ url }) => {
        try {
          const content = await loadContent(url, env);
          // AIが渡してくるのは入力したURLか着いた先のURLのどちらか。両方から引けるようにする。
          const requestedKey = memoKey(url);
          const resolvedKey = memoKey(content.canonicalUrl);
          loaded.set(requestedKey, content);
          loaded.set(resolvedKey, content);
          return {
            loaded: true,
            url: content.canonicalUrl,
            // 中継URLだったことは、AIが「読み物ではなかった」と判断する材料になる。
            requested_url: requestedKey === resolvedKey ? undefined : url,
            source: content.source,
            title: content.title,
            author: content.author,
            published_at: content.publishedAt,
            fetch_complete: content.complete,
            body: content.markdown,
          };
        } catch (error) {
          const clipError = asClipError(error, 'fetch');
          console.warn(
            JSON.stringify({
              stage: clipError.stage,
              status: clipError.status,
              message: clipError.message,
              tool: 'load_content',
            }),
          );
          // どこで落ちたかはstageで足りる。散文はモデルが書く。
          return { loaded: false, failed_at: clipError.stage };
        }
      },
    }),
    save_loaded: tool({
      description: [
        'load_contentでこのターンに読み込んだ記事を、Markdownに整えてユーザーのGitHubリポジトリへ保存する。',
        'load_contentが返したurlをそのまま渡すこと。',
        '読み込んでいないURLは保存できない。取得もせずに拒否するので、先にload_contentを呼ぶこと。',
        '本文は返さない。中身はload_contentの結果にある。',
        '既に保存済みの記事をもう一度渡すと、同じ場所を上書きする。',
      ].join(''),
      inputSchema: z.object({
        url: z.string().describe('load_contentが返したurl。1回につき1件。'),
      }),
      execute: async ({ url }) => {
        // 順序の唯一の保証。名前と説明文は守らせるための働きかけでしかなく、実際に止めるのはここ。
        // モデルが組み立てた実在しないURLも、読んでいない以上ここで止まる。
        const content = loaded.get(memoKey(url));
        if (!content) return { saved: false, not_loaded: url };
        try {
          return await saveLoaded(env, content, receivedAt);
        } catch (error) {
          const clipError = asClipError(error, 'github');
          console.warn(
            JSON.stringify({
              stage: clipError.stage,
              status: clipError.status,
              message: clipError.message,
              tool: 'save_loaded',
            }),
          );
          return { saved: false, failed_at: clipError.stage };
        }
      },
    }),
    /**
     * 単体のみ。一括を扱うツールは作らない（ADR 0010）。
     * これは利便性ではなく、記事本文とWeb検索結果という第三者のテキストが
     * モデルの文脈に入っている前提での判断（ADR 0006 / 0009）。
     */
    set_clip_dismissed: tool({
      description: [
        '保存済みのクリップに「片付けた」印を付ける、または外す。',
        '週次ダイジェストや保存の後に「これはもういい」「片付けて」と言われたときに使う。',
        '片付けた印が付いたクリップは、週次ダイジェストに出てこなくなる。読んだかどうかは記録しない。',
        'pathはダイジェストの一覧やsave_loadedの結果に出てきたものをそのまま渡す。1回につき1件。',
      ].join(''),
      inputSchema: z.object({
        path: z.string().describe('clips/ から始まるクリップのパス。'),
        dismissed: z.boolean().describe('片付けるならtrue、印を外して戻すならfalse。'),
      }),
      execute: async ({ path, dismissed }) => {
        try {
          // 台帳に無いパスは更新できない。モデルが組み立てた見当違いのパスを黙って成功にしない。
          const found = await setClipDismissed(env, path, dismissed, receivedAt);
          return found ? { updated: true, path, dismissed } : { updated: false, unknown_path: path };
        } catch (error) {
          const clipError = asClipError(error, 'clips');
          console.warn(
            JSON.stringify({
              stage: clipError.stage,
              message: clipError.message,
              tool: 'set_clip_dismissed',
            }),
          );
          return { updated: false, failed_at: clipError.stage };
        }
      },
    }),
  };
}
