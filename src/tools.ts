import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import {
  clipTitle,
  deleteClip,
  type FoundClip,
  recordClip,
  selectClipsByPath,
  setClipDismissed,
} from './clips';
import { logFailure } from './errors';
import { clipExcerpt } from './excerpt';
import { loadContent, truncateContent } from './fetchers';
import { parseClipFrontMatter } from './front-matter';
import {
  deleteGitHubFile,
  getGitHubFile,
  getGitHubTextFile,
  listGitHubClipFiles,
  putGitHubFile,
  searchGitHubCode,
} from './github';
import { renderClipMarkdown } from './markdown';
import {
  coreToolDescriptions,
  coreToolSchemas,
  LIST_CLIPS_LIMIT,
} from './tool-contract';
import type { ClipRefPayload } from './tool-state';
import { queueTranslation } from './translate';
import type { Env, FetchedContent } from './types';
import { buildClipPath, clipNameMatches } from './url';

/**
 * フロントマターの真偽値を読む。GitHub上へ手で置かれたファイルなど、書かれていないこともある。
 * 「false」と「書かれていない」を混ぜないため、`undefined`を潰さない。
 */
function frontMatterFlag(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** 保存先パスと、あれば台帳の注釈。検索と一覧が同じ形でrefの発行へ渡す。 */
interface ClipCandidate {
  path: string;
  annotation?: FoundClip;
  /** Code Searchが返した保存済みMarkdownのURL。一覧側は持たない（ADR 0031）。 */
  githubUrl?: string;
  snippet?: string;
}

function searchSnippet(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 240) : undefined;
}

/**
 * 候補へ台帳の注釈を足す。台帳が落ちても候補そのものは返す（ADR 0020）。
 * D1は母集団ではないので、行が無いことを候補から落とす理由にしない。
 */
async function annotateClips(
  env: Env,
  tool: string,
  paths: string[],
): Promise<Map<string, FoundClip>> {
  try {
    return await selectClipsByPath(env, paths);
  } catch (error) {
    logFailure(error, 'clips', `${tool}_annotations`);
    return new Map();
  }
}

/**
 * `clipped_at`の新しい順、同着はパス昇順。`selectAllClips`と同じ規則で、
 * 台帳に行が無いクリップは`clippedAt`を持たないため末尾に来る（ADR 0031）。
 */
function byRecency(a: ClipCandidate, b: ClipCandidate): number {
  const left = a.annotation?.clippedAt ?? '';
  const right = b.annotation?.clippedAt ?? '';
  if (left !== right) return left < right ? 1 : -1;
  return a.path < b.path ? -1 : 1;
}

/** 候補へまとめてrefを発行し、ツールの返り値の形にする。検索と一覧で共通。 */
async function toFoundClips(env: Env, ownerId: string, candidates: ClipCandidate[]) {
  // 0件でDurable Objectへ往復しない。検索が空を返すのは日常的な経路である。
  if (candidates.length === 0) return [];
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const clips = candidates.map((candidate) => ({
    ...candidate,
    title: clipTitle({ path: candidate.path, title: candidate.annotation?.title ?? null }),
  }));
  const refs = await state.putClips(
    clips.map(({ path, title }): ClipRefPayload => ({ path, title })),
  );
  return clips.map((clip, index) => ({
    // `putClips`は渡した数だけ順番どおりに返す。
    clip_ref: refs[index] as string,
    path: clip.path,
    title: clip.title,
    url: clip.annotation?.url ?? undefined,
    github_url: clip.githubUrl,
    clipped_at: clip.annotation?.clippedAt || undefined,
    dismissed: clip.annotation ? clip.annotation.dismissedAt !== null : null,
    snippet: clip.snippet,
  }));
}

async function saveLoaded(
  env: Env,
  content: FetchedContent,
  receivedAt: string,
  bodyLanguage: string | undefined,
) {
  const path = buildClipPath(content.title);
  const existing = await getGitHubFile(env, path);
  const saved = await putGitHubFile(env, path, renderClipMarkdown(content, receivedAt), {
    sha: existing?.sha,
  });
  // 台帳は正本ではなく注釈なので、書けなくても保存そのものは成立させる（ADR 0017）。
  // 記事はGitHubに在り、D1はバックフィルで作り直せる。
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
    logFailure(error, 'clips', 'save_loaded', { path });
  }
  // 日本語でなければ翻訳の札を投げる。訳すのは待ち行列の向こうで、保存の返りは待たない。
  // 通常BotもMCPもこの1箇所を通るので、入口によらず同じように訳される（ADR 0027）。
  try {
    await queueTranslation(env, { path, sha: saved.sha }, bodyLanguage);
  } catch (error) {
    logFailure(error, 'clips', 'queue_translation', { path });
  }
  return { saved: true as const, path, github_url: saved.htmlUrl, title: content.title };
}

function refFailure(ref: string, error: 'unknown_ref' | 'wrong_kind' | 'expired') {
  return { ref, ref_error: error };
}

export async function loadContentTool(
  env: Env,
  ownerId: string,
  rawArgs: unknown,
) {
  const { url } = coreToolSchemas.load_content.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  try {
    const content = await loadContent(url, env);
    const loadedRef = await state.putLoaded(content);
    return {
      loaded: true,
      loaded_ref: loadedRef,
      url: content.canonicalUrl,
      requested_url: url === content.canonicalUrl ? undefined : url,
      source: content.source,
      title: content.title,
      author: content.author,
      published_at: content.publishedAt,
      fetch_complete: content.complete,
      body: content.markdown,
    };
  } catch (error) {
    return { loaded: false, failed_at: logFailure(error, 'fetch', 'load_content') };
  }
}

export async function saveLoadedTool(env: Env, ownerId: string, receivedAt: string, rawArgs: unknown) {
  const { loaded_ref: ref, body_language: bodyLanguage } =
    coreToolSchemas.save_loaded.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const resolved = await state.resolveLoaded(ref);
  if (!resolved.ok) return { saved: false as const, ...refFailure(ref, resolved.error) };
  try {
    return await saveLoaded(env, resolved.payload, receivedAt, bodyLanguage);
  } catch (error) {
    return { saved: false as const, failed_at: logFailure(error, 'github', 'save_loaded') };
  }
}

export async function setClipDismissedTool(env: Env, receivedAt: string, rawArgs: unknown) {
  const { path, dismissed } = coreToolSchemas.set_clip_dismissed.parse(rawArgs);
  try {
    const found = await setClipDismissed(env, path, dismissed, receivedAt);
    return found ? { updated: true, path, dismissed } : { updated: false, unknown_path: path };
  } catch (error) {
    return { updated: false, failed_at: logFailure(error, 'clips', 'set_clip_dismissed') };
  }
}

export async function findClipsTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { query } = coreToolSchemas.find_clips.parse(rawArgs);
  try {
    const matches = await searchGitHubCode(env, query);
    const annotations = await annotateClips(env, 'find_clips', matches.map((match) => match.path));
    const found = await toFoundClips(
      env,
      ownerId,
      matches.map((match) => ({
        path: match.path,
        annotation: annotations.get(match.path),
        githubUrl: match.htmlUrl,
        snippet: searchSnippet(match.snippet),
      })),
    );
    return { found };
  } catch (error) {
    return { found: [], failed_at: logFailure(error, 'github', 'find_clips') };
  }
}

/**
 * 題名での在否確認（ADR 0031）。母集団はGitHubのファイル一覧で、二次索引を経由しない。
 *
 * 成功時にだけ`matched`を返すのが契約の本体である。`matched`があることが全件を
 * 走査した証拠になり、`matched === 0`は「保存されていない」という事実として使える。
 * 失敗時は`matched`を返さないので、0件と見に行けなかったことが形として別物になる。
 */
export async function listClipsTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { title_query: titleQuery } = coreToolSchemas.list_clips.parse(rawArgs);
  let paths: string[];
  try {
    paths = await listGitHubClipFiles(env);
  } catch (error) {
    return { found: [], failed_at: logFailure(error, 'github', 'list_clips') };
  }

  const matched = paths.filter((path) => clipNameMatches(path, titleQuery ?? ''));
  // 任意の一部を返すと、それが全部だと誤らせる。切らずに件数だけを返す（ADR 0031）。
  if (matched.length > LIST_CLIPS_LIMIT) {
    return { found: [], matched: matched.length, too_many: true };
  }

  const annotations = await annotateClips(env, 'list_clips', matched);
  const candidates = matched
    .map((path) => ({ path, annotation: annotations.get(path) }))
    .sort(byRecency);
  return { found: await toFoundClips(env, ownerId, candidates), matched: matched.length };
}

export async function readClipTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { clip_ref: ref } = coreToolSchemas.read_clip.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const resolved = await state.resolveClip(ref);
  if (!resolved.ok) return { found: false, ...refFailure(ref, resolved.error) };
  const clip = resolved.payload;
  try {
    const file = await getGitHubTextFile(env, clip.path);
    if (!file) {
      return { found: false, missing: true, clip_ref: ref };
    }
    const { fields, body } = parseClipFrontMatter(file.content);
    return {
      found: true,
      clip_ref: ref,
      path: clip.path,
      title: fields.title,
      url: fields.source_url,
      // 取得時の素性はフロントマターにしか残らない。ここで捨てると、後から読んだAIには
      // 「どこから取ったものか」「全文が取れているのか」が分からない（ADR 0026）。
      source: fields.source_type,
      fetch_complete: frontMatterFlag(fields.fetch_complete),
      // 上限を超えたことは`truncateContent`が本文の末尾へ書く。別に旗を立てない。
      body: truncateContent(body.trim()).text,
    };
  } catch (error) {
    return {
      found: false,
      failed_at: logFailure(error, 'github', 'read_clip', { path: clip.path }),
    };
  }
}

export async function deleteClipTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { clip_ref: ref } = coreToolSchemas.delete_clip.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const resolved = await state.resolveClip(ref);
  if (!resolved.ok) return { deleted: false, ...refFailure(ref, resolved.error) };
  const clip = resolved.payload;
  let removed: boolean;
  try {
    removed = await deleteGitHubFile(env, clip.path);
  } catch (error) {
    return { deleted: false, failed_at: logFailure(error, 'github', 'delete_clip') };
  }
  try {
    await deleteClip(env, clip.path);
  } catch (error) {
    logFailure(error, 'clips', 'delete_clip', { path: clip.path });
  }
  return { deleted: true, title: clip.title, github: removed ? 'deleted' : 'missing' };
}

export type CoreToolResult = Awaited<
  ReturnType<
    | typeof loadContentTool
    | typeof saveLoadedTool
    | typeof setClipDismissedTool
    | typeof findClipsTool
    | typeof listClipsTool
    | typeof readClipTool
    | typeof deleteClipTool
  >
>;

/** AI SDK用の薄いadapter。業務処理は上のuse caseへ集約する。 */
export function createTools(
  env: Env,
  ownerId: string,
  receivedAt: string,
  google: GoogleGenerativeAIProvider,
) {
  return {
    google_search: google.tools.googleSearch({}),
    load_content: tool({
      description: coreToolDescriptions.load_content,
      inputSchema: coreToolSchemas.load_content,
      execute: (args) => loadContentTool(env, ownerId, args),
    }),
    save_loaded: tool({
      description: coreToolDescriptions.save_loaded,
      inputSchema: coreToolSchemas.save_loaded,
      execute: (args) => saveLoadedTool(env, ownerId, receivedAt, args),
    }),
    set_clip_dismissed: tool({
      description: coreToolDescriptions.set_clip_dismissed,
      inputSchema: coreToolSchemas.set_clip_dismissed,
      execute: (args) => setClipDismissedTool(env, receivedAt, args),
    }),
    find_clips: tool({
      description: coreToolDescriptions.find_clips,
      inputSchema: coreToolSchemas.find_clips,
      execute: (args) => findClipsTool(env, ownerId, args),
    }),
    list_clips: tool({
      description: coreToolDescriptions.list_clips,
      inputSchema: coreToolSchemas.list_clips,
      execute: (args) => listClipsTool(env, ownerId, args),
    }),
    read_clip: tool({
      description: coreToolDescriptions.read_clip,
      inputSchema: coreToolSchemas.read_clip,
      execute: (args) => readClipTool(env, ownerId, args),
    }),
    delete_clip: tool({
      description: coreToolDescriptions.delete_clip,
      inputSchema: coreToolSchemas.delete_clip,
      execute: (args) => deleteClipTool(env, ownerId, args),
    }),
  };
}
