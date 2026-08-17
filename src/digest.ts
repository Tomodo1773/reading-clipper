import type { ModelMessage } from 'ai';
import {
  type DigestClip,
  markDigestShown,
  selectDigestClips,
  selectUndismissed,
  setClipDismissed,
} from './clips';
import { openSlackDirectMessage, postSlackMessage, updateSlackMessage } from './slack';
import type { Env } from './types';
import { asRecord } from './utils';

/**
 * ダイジェストの行に付くボタン。押下はAIを経由せず直接D1を更新する（ADR 0010）。
 * `action_id`と`value`で意図が確定して届くものを、自然文へ落として再解釈させない。
 */
export const DISMISS_ACTION_ID = 'dismiss_clip';

/** 読んだかどうかを主張しない語にする（ADR 0010）。「既読」とは呼ばない。 */
const DISMISS_LABEL = '片付ける';

interface DigestBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
  accessory?: {
    type: 'button';
    text: { type: 'plain_text'; text: string };
    action_id: string;
    value: string;
  };
}

/** ADR 0005でファイル名を記事タイトルそのものにしたため、パスの末尾がそのまま題名になる。 */
function clipTitle(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '');
}

/** SlackのmrkdwnはこれだけをHTMLエンティティとして扱う。リンクのURL側にも同じ規則が要る。 */
function escapeMrkdwn(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clipHref(env: Env, clip: DigestClip): string {
  // `<url|ラベル>`は最初の`|`で切れる。URLの`|`はWHATWGのシリアライズで残るので自分で潰す。
  if (clip.url) return clip.url.replace(/\|/g, '%7C');
  const encoded = clip.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${env.GITHUB_REPO}/blob/main/${encoded}`;
}

/** 「未読」と呼ばない。記録しているのは片付けたかどうかだけである（ADR 0010）。 */
function headerBlock(remaining: number): DigestBlock {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        remaining === 0
          ? '*まだ片付いていないクリップ*\nいまは残っていないわ。'
          : `*まだ片付いていないクリップ* ${remaining}件`,
    },
  };
}

function clipBlock(env: Env, clip: DigestClip): DigestBlock {
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${escapeMrkdwn(clipHref(env, clip))}|${escapeMrkdwn(clipTitle(clip.path))}>`,
    },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: DISMISS_LABEL },
      action_id: DISMISS_ACTION_ID,
      value: clip.path,
    },
  };
}

export function digestBlocks(env: Env, clips: DigestClip[]): DigestBlock[] {
  return [headerBlock(clips.length), ...clips.map((clip) => clipBlock(env, clip))];
}

/** blocksを読めないクライアントと通知に出る文。 */
export function digestText(count: number): string {
  return count === 0 ? '片付いていないクリップは無い' : `片付いていないクリップが${count}件`;
}

/** メッセージのblocksから、クリップの行とそのパスだけを取り出す。 */
function clipRows(blocks: unknown[]): Array<{ block: unknown; path: string }> {
  return blocks.flatMap((block) => {
    const accessory = asRecord(asRecord(block)?.accessory);
    const path = accessory?.action_id === DISMISS_ACTION_ID ? accessory.value : undefined;
    return typeof path === 'string' ? [{ block, path }] : [];
  });
}

/**
 * 残す行だけにして組み直す。
 *
 * 行そのものはSlackのpayloadに入っているものをそのまま使い、作り直さない。
 * 見出しだけは残り件数を持つので付け替える。
 */
export function keepClipBlocks(blocks: unknown[], keep: ReadonlySet<string>): unknown[] {
  const rows = clipRows(blocks)
    .filter((row) => keep.has(row.path))
    .map((row) => row.block);
  return [headerBlock(rows.length), ...rows];
}

/**
 * ダイジェストの内容をスレッドの会話へ残す（ADR 0010）。
 * これがあるので「3番目のやつ片付けて」と言われた対象をAIが特定でき、一覧用のツールが要らない。
 *
 * 何が起点でこの一覧が出たのかを先に置き、履歴を他のターンと同じ user → assistant の形に保つ。
 */
function digestTurn(clips: DigestClip[]): ModelMessage[] {
  const lines = clips.map((clip, index) => `${index + 1}. ${clipTitle(clip.path)}（${clip.path}）`);
  return [
    { role: 'user', content: '（日曜の定期通知）まだ片付いていないクリップを出して。' },
    {
      role: 'assistant',
      content: `まだ片付いていないクリップを${clips.length}件送ったわ。\n${lines.join('\n')}`,
    },
  ];
}

/** 日曜9時（JST）に1通投稿する。cronトリガーはUTC指定なので`0 0 * * SUN`。 */
export async function runWeeklyDigest(env: Env, now = new Date()): Promise<void> {
  const clips = await selectDigestClips(env);
  const channel = await openSlackDirectMessage(env.SLACK_BOT_TOKEN, env.SLACK_ALLOWED_USER_ID);
  const at = now.toISOString();
  const ts = await postSlackMessage({
    token: env.SLACK_BOT_TOKEN,
    channel,
    text: digestText(clips.length),
    blocks: digestBlocks(env, clips),
    idempotencyKey: `digest:${at.slice(0, 10)}`,
  });
  await markDigestShown(
    env,
    clips.map((clip) => clip.path),
    at,
  );
  // 0件のときは会話へ残す中身が無い。投稿自体は「今週は片付いている」を伝えるために行う。
  if (clips.length === 0) return;
  const thread = env.THREAD.get(env.THREAD.idFromName(`${channel}:${ts}`));
  await thread.append(digestTurn(clips).map((message) => JSON.stringify(message)));
}

/**
 * ボタンからのDismiss。D1を更新してから、まだ片付いていない行だけのメッセージへ差し替える。
 *
 * 押された行を落とすのではなくD1に問い直すのは、連続で押したときのため。
 * 2回目のpayloadは1回目の`chat.update`が届く前の`blocks`を含むので、
 * 差分で作ると片付けたばかりの行がボタンごと書き戻る。
 */
export async function dismissDigestClip(
  env: Env,
  target: { path: string; channel: string; messageTs: string; blocks: unknown[] },
): Promise<void> {
  await setClipDismissed(env, target.path, true, new Date().toISOString());
  const alive = await selectUndismissed(env, clipRows(target.blocks).map((row) => row.path));
  const blocks = keepClipBlocks(target.blocks, alive);
  await updateSlackMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: target.channel,
    ts: target.messageTs,
    text: digestText(blocks.length - 1),
    blocks,
  });
}
