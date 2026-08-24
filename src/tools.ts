import type { GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { tool } from 'ai';
import { refreshClipIndex } from './clip-index';
import { isGeneratedClipIndex } from './clip-index-format';
import {
  clipTitle,
  deleteClip,
  type FoundClip,
  recordClip,
  selectClipsByPath,
  setClipDismissed,
  type ClipRow,
} from './clips';
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
import { renderClipMarkdown } from './markdown';
import {
  coreToolDescriptions,
  coreToolSchemas,
} from './tool-contract';
import type { ClipRefPayload } from './tool-state';
import type { Env, FetchedContent } from './types';
import { buildClipPath } from './url';

function toolFailure(
  error: unknown,
  stage: ProcessingStage,
  toolName: string,
  extra: Record<string, unknown> = {},
): ProcessingStage {
  const clipError = asClipError(error, stage);
  console.warn(
    JSON.stringify({
      stage: clipError.stage,
      status: clipError.status,
      message: clipError.message,
      tool: toolName,
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

async function findSavedClips(env: Env, query: string): Promise<SearchClip[]> {
  const matches = await searchGitHubCode(env, query);
  let annotations = new Map<string, FoundClip>();
  try {
    annotations = await selectClipsByPath(env, matches.map((match) => match.path));
  } catch (error) {
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

async function refreshClipIndexBestEffort(env: Env, path: string): Promise<void> {
  try {
    await refreshClipIndex(env);
  } catch (error) {
    toolFailure(error, 'github', 'refresh_clip_index', { path });
  }
}

async function saveLoaded(env: Env, content: FetchedContent, receivedAt: string) {
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
    toolFailure(error, 'clips', 'save_loaded', { path });
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
    return { loaded: false, failed_at: toolFailure(error, 'fetch', 'load_content') };
  }
}

export async function saveLoadedTool(env: Env, ownerId: string, receivedAt: string, rawArgs: unknown) {
  const { loaded_ref: ref } = coreToolSchemas.save_loaded.parse(rawArgs);
  const state = env.TOOL_STATE.get(env.TOOL_STATE.idFromName(ownerId));
  const resolved = await state.resolveLoaded(ref);
  if (!resolved.ok) return { saved: false as const, ...refFailure(ref, resolved.error) };
  try {
    return await saveLoaded(env, resolved.payload, receivedAt);
  } catch (error) {
    return { saved: false as const, failed_at: toolFailure(error, 'github', 'save_loaded') };
  }
}

export async function setClipDismissedTool(env: Env, receivedAt: string, rawArgs: unknown) {
  const { path, dismissed } = coreToolSchemas.set_clip_dismissed.parse(rawArgs);
  try {
    const found = await setClipDismissed(env, path, dismissed, receivedAt);
    return found ? { updated: true, path, dismissed } : { updated: false, unknown_path: path };
  } catch (error) {
    return { updated: false, failed_at: toolFailure(error, 'clips', 'set_clip_dismissed') };
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
    return { found: [], failed_at: toolFailure(error, 'github', 'find_clips') };
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
    const text = body.trim();
    const complete = text.length <= MAX_READ_CHARS;
    return {
      found: true,
      clip_ref: ref,
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
    return { deleted: false, failed_at: toolFailure(error, 'github', 'delete_clip') };
  }
  try {
    await deleteClip(env, clip.path);
    await refreshClipIndexBestEffort(env, clip.path);
  } catch (error) {
    toolFailure(error, 'clips', 'delete_clip', { path: clip.path });
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
