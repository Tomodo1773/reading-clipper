import { clipTitle, countClips, type RecentClip, selectRecentClips } from './clips';
import {
  CLIP_INDEX_PATH,
  type ClipIndexEntry,
  isGeneratedClipIndex,
  renderClipIndex,
} from './clip-index-format';
import { ClipError, logFailure } from './errors';
import { getGitHubTextFile, putGitHubFile } from './github';
import type { Env } from './types';

/**
 * SHAの競合でやり直す回数（ADR 0023）。
 *
 * Slackで3〜4件を続けて片付けると、押下ごとに独立した更新が並行して409が出る。
 * READMEは毎回D1全体から作り直す冪等な操作なので、取りこぼした回を取り返す必要はない。
 * 最後の1回さえ通れば、それまでの片付けもまとめて反映される。
 */
const MAX_REFRESH_ATTEMPTS = 4;

function indexEntries(clips: RecentClip[]): ClipIndexEntry[] {
  return clips.map((clip) => ({ ...clip, title: clipTitle(clip) }));
}

/**
 * D1からREADME全体を再生成する。409は外部更新との競合なので、最新SHAから取り直す。
 * 呼び出し側がベストエフォートとして扱い、記事本体の保存・削除には波及させない。
 */
export async function refreshClipIndex(env: Env): Promise<void> {
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
    const [clips, counts, existing] = await Promise.all([
      selectRecentClips(env),
      countClips(env),
      getGitHubTextFile(env, CLIP_INDEX_PATH),
    ]);
    if (existing && !isGeneratedClipIndex(CLIP_INDEX_PATH, existing.content)) {
      throw new ClipError('clips/README.md is not managed by reading-clipper', 'github', false);
    }
    try {
      await putGitHubFile(
        env,
        CLIP_INDEX_PATH,
        renderClipIndex(indexEntries(clips), counts),
        {
          sha: existing?.sha,
          message: existing ? 'Update clip index' : 'Add clip index',
        },
      );
      return;
    } catch (error) {
      const last = attempt >= MAX_REFRESH_ATTEMPTS - 1;
      if (!(error instanceof ClipError) || error.status !== 409 || last) throw error;
    }
  }
}

/**
 * 派生ビューの作り直しなので、失敗しても呼び出し側の操作は成立させる（ADR 0017）。
 * 記事の保存・削除・片付けの本体は既に済んでいて、次の更新でやり直せる。
 */
export async function refreshClipIndexBestEffort(env: Env, path: string): Promise<void> {
  try {
    await refreshClipIndex(env);
  } catch (error) {
    logFailure(error, 'github', 'refresh_clip_index', { path });
  }
}
