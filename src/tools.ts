import { asClipError } from './errors';
import { fetchContent } from './fetchers';
import { getGitHubFile, putGitHubFile } from './github';
import { renderClipMarkdown } from './markdown';
import type { Env } from './types';
import { buildClipPath, canonicalizeUrl } from './url';
import { asRecord, stringField } from './utils';

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'save_clip',
      description: [
        'URLの記事を取得してMarkdownに整え、ユーザーのGitHubリポジトリへ保存する。',
        '「あとで読む」ために取っておきたいURLを渡されたときに使う。',
        '取得した本文をそのまま返すので、保存した記事について要約したり質問に答えたりするときは、',
        '別の手段を取らずにこのツールの結果を読むこと。',
        '既に保存済みのURLをもう一度渡すと、取得し直して同じ場所を上書きする。',
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '保存する記事のHTTP(S) URL。1回につき1件。',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

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
 * モデルが要求したツールを実行する。
 *
 * 恒久的な失敗はツール結果として返し、モデルにその事実を伝えさせる。
 * 一時的な失敗は投げてQueueの再試行に任せる。ターンの永続化は成功後に一度だけ行うため、
 * 再試行しても会話が二重に積まれることはない。
 */
export async function runTool(
  name: string,
  argumentsJson: string,
  env: Env,
  receivedAt: string,
): Promise<unknown> {
  if (name !== 'save_clip') return { saved: false, failed_at: 'unknown_tool' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson || '{}');
  } catch {
    return { saved: false, failed_at: 'validation' };
  }
  const url = stringField(asRecord(parsed), 'url');
  if (!url) return { saved: false, failed_at: 'validation' };

  try {
    return await saveClip(env, url, receivedAt);
  } catch (error) {
    const clipError = asClipError(error, 'fetch');
    if (clipError.retryable) throw clipError;
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
}
