import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import { refreshClipIndexBestEffort } from './clip-index';
import { isGeneratedClipIndex } from './clip-index-format';
import {
  clipTitle,
  deleteClip,
  type FoundClip,
  recordClip,
  selectClipsByPath,
  type ClipRow,
} from './clips';
import { applyClipDismissal } from './dismiss';
import { logFailure } from './errors';
import { clipExcerpt } from './excerpt';
import { loadContent, truncateContent } from './fetchers';
import { parseClipFrontMatter } from './front-matter';
import {
  deleteGitHubFile,
  getGitHubFile,
  getGitHubTextFile,
  putGitHubFile,
  searchGitHubCode,
} from './github';
import { renderClipMarkdown } from './markdown';
import {
  coreToolDescriptions,
  coreToolSchemas,
} from './tool-contract';
import type { ClipRefPayload } from './tool-state';
import { queueTranslation } from './translate';
import type { Env, FetchedContent } from './types';
import { buildClipPath } from './url';

/**
 * フロントマターの真偽値を読む。GitHub上へ手で置かれたファイルなど、書かれていないこともある。
 * 「false」と「書かれていない」を混ぜないため、`undefined`を潰さない。
 */
function frontMatterFlag(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

interface SearchClip extends ClipRow {
  dismissed: boolean | null;
  githubUrl: string;
  snippet?: string;
}

function searchSnippet(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/gu, ' ').trim();
  return text ? text.slice(0, 240) : undefined;
}

async function findSavedClips(env: Env, query: string): Promise<SearchClip[]> {
  const matches = await searchGitHubCode(env, query);
  let annotations = new Map<string, FoundClip>();
  try {
    annotations = await selectClipsByPath(env, matches.map((match) => match.path));
  } catch (error) {
    logFailure(error, 'clips', 'find_clips_annotations');
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
    const found = await applyClipDismissal(env, { path, dismissed, at: receivedAt });
    return found ? { updated: true, path, dismissed } : { updated: false, unknown_path: path };
  } catch (error) {
    return { updated: false, failed_at: logFailure(error, 'clips', 'set_clip_dismissed') };
  }
}

export async function findClipsTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { query } = coreToolSchemas.find_clips.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  try {
    const clips = await findSavedClips(env, query);
    const found = await Promise.all(
      clips.map(async (clip) => {
        const payload: ClipRefPayload = { path: clip.path, title: clipTitle(clip) };
        return {
          clip_ref: await state.putClip(payload),
          path: clip.path,
          title: payload.title,
          url: clip.url ?? undefined,
          github_url: clip.githubUrl,
          clipped_at: clip.clippedAt || undefined,
          dismissed: clip.dismissed,
          snippet: clip.snippet,
        };
      }),
    );
    return { found };
  } catch (error) {
    return { found: [], failed_at: logFailure(error, 'github', 'find_clips') };
  }
}

export async function readClipTool(env: Env, ownerId: string, rawArgs: unknown) {
  const { clip_ref: ref } = coreToolSchemas.read_clip.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const resolved = await state.resolveClip(ref);
  if (!resolved.ok) return { found: false, ...refFailure(ref, resolved.error) };
  const clip = resolved.payload;
  try {
    const file = await getGitHubTextFile(env, clip.path);
    if (!file || isGeneratedClipIndex(clip.path, file.content)) {
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
    await refreshClipIndexBestEffort(env, clip.path);
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
