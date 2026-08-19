import { type AnyMessageBlock, SlackAPIClient } from 'slack-edge';
import { setClipDismissed } from './clips';
import type { Env, SavedClip } from './types';

/**
 * 読んだかどうかを主張しない語にする（ADR 0010）。「既読」とは呼ばない。
 * ダイジェストの行のボタンとクリップ直後の返信のボタンで同じ語を使う。
 */
export const DISMISS_LABEL = '片付ける';

/**
 * クリップ直後の返信に付くボタン。ダイジェストの行のボタンとは`action_id`を分ける（ADR 0015）。
 *
 * 分けるのは見た目の都合ではない。ダイジェスト側の押下処理はメッセージをダイジェストの形
 * （見出し＋`clip-N`の組）へ組み直すため、同じIDで返信メッセージから届くと返事の本文ごと消える。
 */
export const THREAD_DISMISS_ACTION_ID = 'dismiss_thread_clip';

/** 押した後に残す一行。トグルにはしない。戻すのは会話の`set_clip_dismissed`が受け持つ。 */
const DISMISSED_TEXT = '片付けた';

/** 台帳に行が無いクリップ。GitHubへは保存できたがD1の記録に失敗した場合にこうなる。 */
const NOT_IN_LEDGER_TEXT = '片付けられなかった。台帳にこのクリップが無いわ。';

/** sectionのテキスト上限は3000文字。超えるとメッセージ全体が`invalid_blocks`で拒否される。 */
const MAX_SECTION_CHARS = 2900;

/** buttonの`plain_text`は75文字まで。 */
const MAX_BUTTON_CHARS = 75;

/** 返信本文のブロック。組み立て直さずに済むよう、押下時はこの`block_id`で組を引く。 */
function blockId(index: number): string {
  return `dismiss-${index}`;
}

function truncate(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * 返信本文をsectionへ載せる。
 *
 * 本文はモデルが書いたSlackのmrkdwn（`<url|ラベル>`を含む）なので、エスケープはしない。
 * サロゲートペアの途中で切らないよう、コードユニットではなく文字で割る。
 */
function replySections(reply: string): AnyMessageBlock[] {
  const characters = [...reply];
  const sections: AnyMessageBlock[] = [];
  for (let at = 0; at < characters.length; at += MAX_SECTION_CHARS) {
    sections.push({
      type: 'section',
      text: { type: 'mrkdwn', text: characters.slice(at, at + MAX_SECTION_CHARS).join('') },
    });
  }
  return sections;
}

/**
 * 保存したクリップを片付けるボタン付きの返信を組む（ADR 0015）。
 *
 * クリップ1件につき`actions`ブロックを1つ置く。押されたものだけを差し替えられるようにするため、
 * 1つのブロックへボタンを並べない。1件のときはどれのボタンかが自明なのでラベルに題名を入れない。
 */
export function clipReplyBlocks(reply: string, clips: SavedClip[]): AnyMessageBlock[] {
  return [
    ...replySections(reply),
    ...clips.map((clip, index): AnyMessageBlock => {
      const label = clips.length === 1 ? DISMISS_LABEL : `${DISMISS_LABEL}：${clip.title}`;
      return {
        type: 'actions',
        block_id: blockId(index),
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: truncate(label, MAX_BUTTON_CHARS) },
            action_id: THREAD_DISMISS_ACTION_ID,
            value: clip.path,
          },
        ],
      };
    }),
  ];
}

/** 押されたボタンを持つ`actions`ブロックかどうか。組はパスで引く。 */
function isPressedBlock(block: AnyMessageBlock, path: string): boolean {
  if (block.type !== 'actions') return false;
  return block.elements.some(
    (element) =>
      element.type === 'button' &&
      element.action_id === THREAD_DISMISS_ACTION_ID &&
      element.value === path,
  );
}

/**
 * 押されたクリップのボタンを、結果の一行へ差し替える。
 *
 * ダイジェストのようにD1へ問い直さない。1つの返信が持つのは自分が保存したクリップだけで、
 * 押した組以外は触らないため、続けて押しても他の行が書き戻ることが無い。
 */
export function dismissedReplyBlocks(
  blocks: AnyMessageBlock[],
  path: string,
  found: boolean,
): AnyMessageBlock[] {
  return blocks.map((block) =>
    isPressedBlock(block, path)
      ? {
          type: 'context',
          block_id: block.block_id,
          elements: [{ type: 'plain_text', text: found ? DISMISSED_TEXT : NOT_IN_LEDGER_TEXT }],
        }
      : block,
  );
}

/**
 * 返信のボタンからのDismiss。ボタン押下はAIを経由せず直接D1を更新する（ADR 0010）。
 *
 * 二度押しは同じ状態を書き直すだけなので、専用の冪等キーを持たない。
 */
export async function dismissThreadClip(
  env: Env,
  target: {
    path: string;
    channel: string;
    messageTs: string;
    text: string;
    blocks: AnyMessageBlock[];
  },
): Promise<void> {
  const found = await setClipDismissed(env, target.path, true, new Date().toISOString());
  await new SlackAPIClient(env.SLACK_BOT_TOKEN).chat.update({
    channel: target.channel,
    ts: target.messageTs,
    text: target.text,
    blocks: dismissedReplyBlocks(target.blocks, target.path, found),
  });
}
