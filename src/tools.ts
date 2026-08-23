import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { refreshClipIndex } from './clip-index';
import {
  clipTitle,
  deleteClip,
  type FoundClip,
  recordClip,
  selectClipsByPath,
  setClipDismissed,
} from './clips';
import type { ClipRow } from './clips';
import { asClipError, type ProcessingStage } from './errors';
import { clipExcerpt } from './excerpt';
import { loadContent } from './fetchers';
import { parseClipFrontMatter } from './front-matter';
import {
  deleteGitHubFile,
  getGitHubFile,
  getGitHubTextFile,
  putGitHubFile,
  searchGitHubCode,
} from './github';
import { isGeneratedClipIndex } from './clip-index-format';
import { renderClipMarkdown } from './markdown';
import type { Env, FetchedContent } from './types';
import { buildClipPath, canonicalizeUrl } from './url';

/**
 * ツールの失敗を1行のログに落とし、モデルへ返す`failed_at`を作る。
 *
 * どこで落ちたかはstageで足りる。散文はモデルが書くので、原因ごとに返り値を分けない（ADR 0008）。
 * ログだけが要る呼び出し（GitHubは成功してD1だけ落ちた場合）では、戻り値を捨ててよい。
 */
function toolFailure(
  error: unknown,
  stage: ProcessingStage,
  tool: string,
  extra: Record<string, unknown> = {},
): ProcessingStage {
  const clipError = asClipError(error, stage);
  console.warn(
    JSON.stringify({
      stage: clipError.stage,
      status: clipError.status,
      message: clipError.message,
      tool,
      ...extra,
    }),
  );
  return clipError.stage;
}

const MAX_READ_CHARS = 60_000;

interface SearchClip extends ClipRow {
  dismissed: boolean | null;
  githubUrl: string;
  snippet?: string;
}

function searchSnippet(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 240) : undefined;
}

/** GitHubを母集団として候補を探し、D1の注釈があれば足す（ADR 0020）。 */
async function findSavedClips(env: Env, query: string): Promise<SearchClip[]> {
  const matches = await searchGitHubCode(env, query);

  let annotations = new Map<string, FoundClip>();
  try {
    annotations = await selectClipsByPath(env, matches.map((match) => match.path));
  } catch (error) {
    // D1は注釈レイヤー。落ちてもGitHubで見つけたクリップ自体は返す。
    toolFailure(error, 'clips', 'find_clips_annotations');
  }

  return matches.map((match) => {
    const annotation = annotations.get(match.path);
    return {
      path: match.path,
      title: annotation?.title ?? null,
      url: annotation?.url ?? null,
      clippedAt: annotation?.clippedAt ?? '',
      dismissed: annotation ? annotation.dismissedAt !== null : null,
      githubUrl: match.htmlUrl,
      snippet: searchSnippet(match.snippet),
    };
  });
}

/** 派生ビューの失敗を、先に成立した記事本体の保存・削除へ波及させない。 */
async function refreshClipIndexBestEffort(env: Env, path: string): Promise<void> {
  try {
    await refreshClipIndex(env);
  } catch (error) {
    toolFailure(error, 'github', 'refresh_clip_index', { path });
  }
}

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
  const saved = await putGitHubFile(env, path, renderClipMarkdown(content, receivedAt), {
    sha: existing?.sha,
  });
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
    await refreshClipIndexBestEffort(env, path);
  } catch (error) {
    toolFailure(error, 'clips', 'save_loaded', { path });
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

  /**
   * このターンの検索で見つけたクリップの置き場（ADR 0016）。
   *
   * `delete_clip`が受け取るのはここへ振った番号だけで、パスは受け取らない。保存先パスは
   * 記事タイトルそのものなので（ADR 0005 / 0013）、本文や検索結果に出てきた題名から
   * モデルが実在するパスを組み立てられてしまう。番号なら組み立てようがない。
   *
   * `loaded`と同じくターンをまたぐと消えるが、その場合は`delete_clip`が拒否して
   * `find_clips`からやり直すだけで壊れない。永続的なIDにしないのはこのためで、
   * 番号が会話へ残ると「消す直前に台帳を引き直した」という保証が消える。
   */
  const foundClips = new Map<number, SearchClip>();

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
          return { loaded: false, failed_at: toolFailure(error, 'fetch', 'load_content') };
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
          return { saved: false, failed_at: toolFailure(error, 'github', 'save_loaded') };
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
          return { updated: false, failed_at: toolFailure(error, 'clips', 'set_clip_dismissed') };
        }
      },
    }),
    /**
     * 会話に出ていないクリップを特定するための検索（ADR 0016）。
     *
     * ADR 0010はダイジェストの投稿をスレッドへ書き込むことで一覧ツールを不要としたが、
     * それは対象が必ず会話の中にあるという前提の上に立っている。壊れた保存に気づくのは
     * 後日GitHubを眺めたときでもあり、そのとき対象は会話の中に無い。
     */
    find_clips: tool({
      description: [
        '保存済みのクリップを、題名・URL・本文に含まれる語で探す。',
        'どのクリップのことかを特定するために使う。会話にまだ出ていないクリップは、これで探さないと分からない。',
        '本文も探すので、題名に出てこない話題でも見つかる。結果は最大5件の候補。',
        'snippetは候補を見分ける手掛かりで、記事の内容を答える根拠にはしない。内容はread_clipで読むこと。',
        '結果のrefはread_clipまたはdelete_clipへ渡す番号で、いま返したものだけが有効。次のやり取りでは使えない。',
        'dismissedがnullならD1に注釈が無い。GitHubの検索候補から落とさない。',
        '見つからなければfoundが空になる。そのときは対象が無いということ。',
      ].join(''),
      inputSchema: z.object({
        query: z.string().trim().min(1).max(120).describe('題名・URL・本文に含まれる語。1回につき1つ。'),
      }),
      execute: async ({ query }) => {
        try {
          const clips = await findSavedClips(env, query);
          return {
            found: clips.map((clip) => {
              // 番号は検索をまたいで通し番号にする。2回探しても前の結果が上書きされない。
              const ref = foundClips.size + 1;
              foundClips.set(ref, clip);
              return {
                ref,
                title: clipTitle(clip),
                url: clip.url ?? undefined,
                github_url: clip.githubUrl,
                // set_clip_dismissedはパスで引くので、同じ検索から片付けへも繋げられるようにする。
                path: clip.path,
                clipped_at: clip.clippedAt || undefined,
                dismissed: clip.dismissed,
                snippet: clip.snippet,
              };
            }),
          };
        } catch (error) {
          return { found: [], failed_at: toolFailure(error, 'github', 'find_clips') };
        }
      },
    }),
    read_clip: tool({
      description: [
        'find_clipsが返した候補1件の現在の本文をGitHubから読む。',
        '前に保存した記事の内容を聞かれたら、find_clipsで探してからこれで読むこと。',
        'refはfind_clipsの結果をそのまま渡す。missingなら検索索引が古いので次の候補を試す。',
        'unknown_refならその番号は今のやり取りに無いので、find_clipsから探し直す。',
        'completeがfalseなら長すぎるため末尾を省略している。',
      ].join(''),
      inputSchema: z.object({
        ref: z.number().int().describe('find_clipsが返したref。1回につき1件。'),
      }),
      execute: async ({ ref }) => {
        const clip = foundClips.get(ref);
        if (!clip) return { found: false, unknown_ref: ref };
        try {
          const file = await getGitHubTextFile(env, clip.path);
          if (!file || isGeneratedClipIndex(clip.path, file.content)) {
            return { found: false, missing: true, ref };
          }
          const { fields, body } = parseClipFrontMatter(file.content);
          const text = body.trim();
          const complete = text.length <= MAX_READ_CHARS;
          return {
            found: true,
            ref,
            path: clip.path,
            title: fields.title,
            url: fields.source_url,
            complete,
            body: complete ? text : text.slice(0, MAX_READ_CHARS),
          };
        } catch (error) {
          return {
            found: false,
            failed_at: toolFailure(error, 'github', 'read_clip', { path: clip.path }),
          };
        }
      },
    }),
    /**
     * 保存そのものを無かったことにする（ADR 0016）。
     *
     * `set_clip_dismissed`と違い、これはGitHubを書き換える。ADR 0010がAIにD1を触らせる
     * 根拠とした4条件のうち「GitHubを書き換えない」が崩れるため、可逆性はGitの履歴が担う。
     * 消えるのはHEADからだけで、本文は1つ前のコミットに残る。
     */
    delete_clip: tool({
      description: [
        '保存済みのクリップを、GitHubのファイルごと消す。片付けとは違い、保存を無かったことにする。',
        '本文が入っていない、記事の概要しか保存されていない、記事ではない別のページが保存されている、',
        'といったときに使う。読まないと決めただけならset_clip_dismissedを使うこと。',
        'refはfind_clipsがいま返した番号だけを渡す。パスや題名では消せないので、先にfind_clipsで探すこと。',
        '1回につき1件。',
      ].join(''),
      inputSchema: z.object({
        ref: z.number().int().describe('find_clipsが返したref。1回につき1件。'),
      }),
      execute: async ({ ref }) => {
        // 順序の唯一の保証。説明文は守らせるための働きかけでしかなく、実際に止めるのはここ。
        // 探していないものは消せないので、モデルが組み立てた題名からパスへは届かない。
        const clip = foundClips.get(ref);
        if (!clip) return { deleted: false, unknown_ref: ref };
        let removed: boolean;
        try {
          // GitHubを先に消す。逆にするとD1だけ消えてゴミファイルが残り、
          // ダイジェストに二度と出てこない＝気づけないゴミになる（ADR 0016）。
          removed = await deleteGitHubFile(env, clip.path);
        } catch (error) {
          // ファイルが残っている以上、台帳の行も残す。片方だけ消して黙るのが一番悪い。
          return { deleted: false, failed_at: toolFailure(error, 'github', 'delete_clip') };
        }
        // D1は台帳ではなく注釈レイヤーなので、消せなくてもファイルは既に消えている（ADR 0010）。
        // 残った行はダイジェストに1度出て、「片付ける」を1回押せば終わる。
        try {
          await deleteClip(env, clip.path);
          await refreshClipIndexBestEffort(env, clip.path);
        } catch (error) {
          toolFailure(error, 'clips', 'delete_clip', { path: clip.path });
        }
        return { deleted: true, title: clipTitle(clip), github: removed ? 'deleted' : 'missing' };
      },
    }),
  };
}
