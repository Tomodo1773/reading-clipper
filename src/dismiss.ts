import { type AnyMessageBlock, SlackAPIClient } from 'slack-edge';
import { refreshClipIndexBestEffort } from './clip-index';
import { selectUndismissed, setClipDismissed } from './clips';
import type { Env, SavedClip } from './types';

/**
 * 片付けのボタン。押下はAIを経由せず直接D1を更新する（ADR 0010）。
 * `action_id`と`value`で意図が確定して届くものを、自然文へ落として再解釈させない。
 *
 * 週次ダイジェストの行とクリップ直後の返信で同じボタンを使う。どちらのメッセージも
 * 「クリップの組をいくつか持つ」という同じ形をしていて、押下後の扱いも同じだからである（ADR 0015）。
 */
export const DISMISS_ACTION_ID = 'dismiss_clip';

/** 読んだかどうかを主張しない語にする（ADR 0010）。「既読」とは呼ばない。 */
export const DISMISS_LABEL = '片付ける';

/** buttonの`plain_text`の上限。 */
const MAX_BUTTON_CHARS = 75;

/** 1メッセージに含められるMarkdown blockのテキスト合計上限。 */
const MAX_MARKDOWN_CHARS = 12_000;

/**
 * クリップ1件ぶんのブロックに振る`block_id`の接頭辞。
 *
 * 1件が何ブロックに散るかはメッセージによって違う（ダイジェストは3つ、返信は1つ）。
 * 接頭辞を共通にしておくことで、押下後の組み直しが両方に効く。
 * パスをそのまま入れない。ファイル名が記事タイトルそのままなので255文字上限を超えうる。
 */
export function clipBlockId(index: number): string {
  return `clip-${index}`;
}

/** 押されたクリップを指す唯一の手掛かりは、このボタンの`value`である。 */
export function dismissActionBlock(
  index: number,
  path: string,
  label: string = DISMISS_LABEL,
): AnyMessageBlock {
  return {
    type: 'actions',
    block_id: `${clipBlockId(index)}-act`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: truncate(label, MAX_BUTTON_CHARS) },
        action_id: DISMISS_ACTION_ID,
        value: path,
      },
    ],
  };
}

function truncate(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join('')}…`;
}

/** ブロックがどのクリップの組に属するか。属さないものはundefined。 */
function groupId(block: AnyMessageBlock): string | undefined {
  return block.block_id?.match(/^(clip-\d+)(?:-|$)/)?.[1];
}

/**
 * メッセージのblocksから、クリップの組とそのパスの対応を取り出す。
 * パスはボタンの`value`にしか無いので、組の中から拾う。
 */
function clipPaths(blocks: AnyMessageBlock[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const block of blocks) {
    const id = groupId(block);
    if (id === undefined || block.type !== 'actions') continue;
    for (const element of block.elements) {
      if (element.type === 'button' && element.action_id === DISMISS_ACTION_ID && element.value) {
        paths.set(id, element.value);
      }
    }
  }
  return paths;
}

/**
 * 片付いたクリップの組を落とす。組に属さないブロックはそのまま残す。
 *
 * 残すブロックはSlackのpayloadに入っているものをそのまま使い、作り直さない。
 * D1から作り直すと、ボタンを1回押すたびに残り全件のサムネイルを取り直すことになる。
 */
export function keepAliveClips(
  blocks: AnyMessageBlock[],
  alive: ReadonlySet<string>,
): AnyMessageBlock[] {
  const paths = clipPaths(blocks);
  return blocks.filter((block) => {
    const id = groupId(block);
    return id === undefined || alive.has(paths.get(id) ?? '');
  });
}

/**
 * 保存したクリップを片付けるボタン付きの返信を組む（ADR 0015）。
 *
 * 本文はモデルが書いた標準Markdownを、そのままSlackに変換させる（ADR 0019）。
 * Markdown blockはメッセージ内の合計が12,000文字まで。モデルへの指示だけに頼らず、
 * このSlack境界でも省略して`invalid_blocks`による決定的な再試行を防ぐ。
 *
 * 1件のときはどれのボタンかが自明なので、ラベルに題名を入れない。
 */
export function clipReplyBlocks(reply: string, clips: SavedClip[]): AnyMessageBlock[] {
  return [
    { type: 'markdown', text: truncate(reply, MAX_MARKDOWN_CHARS) },
    ...clips.map((clip, index) =>
      dismissActionBlock(
        index,
        clip.path,
        clips.length === 1 ? DISMISS_LABEL : `${DISMISS_LABEL}：${clip.title}`,
      ),
    ),
  ];
}

/**
 * 片付けの適用。入口はボタンとエージェントのツールの2つあるが、片付けとは
 * 「D1へ印を書き、新着一覧を作り直すところまで」の1つの操作である（ADR 0023）。
 * 取り消し線と件数を出す以上、どちらの入口から片付けても`clips/README.md`が揃う必要がある。
 *
 * 入口ごとに違うのは押した相手への返し方だけなので、それを`respond`で受ける。
 * 一覧の作り直しより先に呼ぶのは、GitHubへの往復で手応えを遅らせないためである。
 * 台帳に無いパスは書き込みが空振りするだけなので、一覧も作り直さない。
 */
export async function applyClipDismissal(
  env: Env,
  target: { path: string; dismissed: boolean; at: string },
  respond?: () => Promise<void>,
): Promise<boolean> {
  const found = await setClipDismissed(env, target.path, target.dismissed, target.at);
  await respond?.();
  if (found) await refreshClipIndexBestEffort(env, target.path);
  return found;
}

/**
 * ボタンからのDismiss。片付けを適用し、まだ片付いていない組だけのメッセージへ差し替える。
 *
 * 押された組を落とすのではなくD1に問い直すのは、連続で押したときのため。
 * 2回目のpayloadは1回目の`chat.update`が届く前の`blocks`を含むので、
 * 差分で作ると片付けたばかりの組がボタンごと書き戻る。
 *
 * 二度押しは同じ状態を書き直すだけなので、専用の冪等キーを持たない。
 * 台帳に無いパスはD1が返さないため、片付いたものと同じく組ごと消える。
 */
export async function dismissClip(
  env: Env,
  target: {
    path: string;
    channel: string;
    messageTs: string;
    text: string;
    blocks: AnyMessageBlock[];
  },
): Promise<void> {
  await applyClipDismissal(
    env,
    { path: target.path, dismissed: true, at: new Date().toISOString() },
    async () => {
      const alive = await selectUndismissed(env, [...clipPaths(target.blocks).values()]);
      await new SlackAPIClient(env.SLACK_BOT_TOKEN).chat.update({
        channel: target.channel,
        ts: target.messageTs,
        // 通知とblocksを読めないクライアント向けの文は、投稿時のものをそのまま持ち越す。
        text: target.text,
        blocks: keepAliveClips(target.blocks, alive),
      });
    },
  );
}
