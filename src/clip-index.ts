import { clipTitle, type ClipRow, selectRecentClips } from './clips';
import {
  CLIP_INDEX_PATH,
  type ClipIndexEntry,
  isGeneratedClipIndex,
  renderClipIndex,
} from './clip-index-format';
import { ClipError } from './errors';
import { getGitHubTextFile, putGitHubFile } from './github';
import type { Env } from './types';

function indexEntries(clips: ClipRow[]): ClipIndexEntry[] {
  return clips.map((clip) => ({ ...clip, title: clipTitle(clip) }));
}

/**
 * D1からREADME全体を再生成する。409は外部更新との競合なので、最新SHAから1回だけやり直す。
 * 呼び出し側がベストエフォートとして扱い、記事本体の保存・削除には波及させない。
 */
export async function refreshClipIndex(env: Env): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [clips, existing] = await Promise.all([
      selectRecentClips(env),
      getGitHubTextFile(env, CLIP_INDEX_PATH),
    ]);
    if (existing && !isGeneratedClipIndex(CLIP_INDEX_PATH, existing.content)) {
      throw new ClipError('clips/README.md is not managed by reading-clipper', 'github', false);
    }
    try {
      await putGitHubFile(
        env,
        CLIP_INDEX_PATH,
        renderClipIndex(indexEntries(clips)),
        {
          sha: existing?.sha,
          message: existing ? 'Update clip index' : 'Add clip index',
        },
      );
      return;
    } catch (error) {
      if (!(error instanceof ClipError) || error.status !== 409 || attempt > 0) throw error;
    }
  }
}
