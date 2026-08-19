import type { ModelMessage } from 'ai';
import { type AnyMessageBlock, type SectionBlock, SlackAPIClient } from 'slack-edge';
import {
  type DigestClip,
  markDigestShown,
  selectDigestClips,
  selectUndismissed,
  setClipDismissed,
} from './clips';
import { DISMISS_LABEL } from './dismiss';
import type { Env } from './types';
import { fetchWithTimeout } from './utils';

/**
 * ダイジェストの行に付くボタン。押下はAIを経由せず直接D1を更新する（ADR 0010）。
 * `action_id`と`value`で意図が確定して届くものを、自然文へ落として再解釈させない。
 */
export const DISMISS_ACTION_ID = 'dismiss_clip';

/** Slackの`image_url`の上限。Qiitaの自動生成OGPは2600文字を超える実例がある。 */
const MAX_IMAGE_URL_CHARS = 3000;

/** Slackが受け付ける画像形式。これ以外を渡すと投稿ごと拒否される。 */
const IMAGE_CONTENT_TYPE = /^image\/(?:png|jpeg|jpg|gif)\b/i;

/** ADR 0005でファイル名を記事タイトルそのものにしたが、長い題名はそこで削られる。 */
function clipTitle(clip: DigestClip): string {
  if (clip.title) return clip.title;
  return (clip.path.split('/').pop() ?? clip.path).replace(/\.md$/, '');
}

/** 保存先はフラットな`clips/{title}.md`なので、ホストは列に持たず`url`から出す。 */
function clipHost(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 「2026年2月に保存」。積読の古さは片付けるかどうかの判断に効く。
 * workerdのタイムゾーンはUTC固定なので、JSTぶんずらしてからUTCの読み出しで日付を取る。
 */
function savedAt(clippedAt: string): string {
  const at = new Date(clippedAt);
  if (Number.isNaN(at.getTime())) return '';
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月に保存`;
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
function headBlocks(remaining: number): AnyMessageBlock[] {
  if (remaining === 0) {
    return [
      { type: 'header', text: { type: 'plain_text', text: 'まだ片付いていないクリップ' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'いまは残っていないわ。' } },
    ];
  }
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `まだ片付いていないクリップ ${remaining}件` },
    },
    { type: 'divider' },
  ];
}

/**
 * 1件を section（タイトルと抜粋、サムネイル）+ actions（ボタン）+ context（メタ）の
 * 3ブロックで表す（ADR 0011）。`accessory`は1つしか置けないため、サムネイルを出すと
 * ボタンは`actions`へ出さざるを得ない。
 *
 * `block_id`は組を識別するためだけに使う。パスをそのまま入れない。
 * ファイル名が記事タイトルそのままなので、`block_id`の255文字上限を超えうる。
 */
function clipBlocks(env: Env, clip: DigestClip, index: number): AnyMessageBlock[] {
  const id = `clip-${index}`;
  const title = clipTitle(clip);
  const link = `*<${escapeMrkdwn(clipHref(env, clip))}|${escapeMrkdwn(title)}>*`;
  const excerpt = clip.excerpt ? `\n${escapeMrkdwn(clip.excerpt)}` : '';
  const meta = [clipHost(clip.url), savedAt(clip.clippedAt)].filter(Boolean).join(' ・ ');
  const section: SectionBlock = {
    type: 'section',
    block_id: id,
    text: { type: 'mrkdwn', text: `${link}${excerpt}` },
  };
  // alt_textは1文字以上が要る。パスからも題名が取れないことは無いが、念のため埋める。
  if (clip.imageUrl) {
    section.accessory = { type: 'image', image_url: clip.imageUrl, alt_text: title || 'クリップ' };
  }
  return [
    section,
    {
      type: 'actions',
      block_id: `${id}-act`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: DISMISS_LABEL },
          action_id: DISMISS_ACTION_ID,
          value: clip.path,
        },
      ],
    },
    // mrkdwnにするとSlackがホスト名をリンクへ変えて`<http://qiita.com|qiita.com>`になる。
    // ここに書式は要らないので、自動リンクの効かないplain_textで出す。
    ...(meta
      ? [
          {
            type: 'context' as const,
            block_id: `${id}-meta`,
            elements: [{ type: 'plain_text' as const, text: meta }],
          },
        ]
      : []),
  ];
}

export function digestBlocks(env: Env, clips: DigestClip[]): AnyMessageBlock[] {
  return [
    ...headBlocks(clips.length),
    ...clips.flatMap((clip, index) => clipBlocks(env, clip, index)),
  ];
}

/** blocksを読めないクライアントと通知に出る文。 */
export function digestText(count: number): string {
  return count === 0 ? '片付いていないクリップは無い' : `片付いていないクリップが${count}件`;
}

/**
 * Slackへ渡せるサムネイルだけを残す（ADR 0011）。
 *
 * Slackは`image_url`をサーバー側で取得しにいき、取れなければ`invalid_blocks`で
 * **メッセージ全体を拒否する**。記事が消えた1件のせいでその週のダイジェストが丸ごと
 * 消えるので、投げる前にこちらで確かめる。
 *
 * 検証するのはWorkersで、実際に取得するのはSlackなので、結果が一致しない場合は残る。
 * これはリスクをゼロにするものではなく減らすもので、**ここからは絶対に投げない**。
 */
export async function withUsableThumbnails(clips: DigestClip[]): Promise<DigestClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      if (!clip.imageUrl || clip.imageUrl.length > MAX_IMAGE_URL_CHARS) {
        return { ...clip, imageUrl: null };
      }
      const usable = await isFetchableImage(clip.imageUrl);
      return { ...clip, imageUrl: usable ? clip.imageUrl : null };
    }),
  );
}

async function isFetchableImage(url: string): Promise<boolean> {
  try {
    // HEADを拒否してGETだけ通すCDNがあるため、Slackと同じくGETで確かめる。本文は読まない。
    const response = await fetchWithTimeout(url, { headers: { accept: 'image/*' } }, 5_000, 'fetch');
    await response.body?.cancel();
    return response.ok && IMAGE_CONTENT_TYPE.test(response.headers.get('content-type') ?? '');
  } catch {
    return false;
  }
}

interface ClipGroup {
  path: string;
  blocks: AnyMessageBlock[];
}

/** ボタンを持つ`actions`ブロックからパスを取り出す。 */
function dismissValue(block: AnyMessageBlock): string | undefined {
  if (block.type !== 'actions') return undefined;
  for (const element of block.elements) {
    if (element.type === 'button' && element.action_id === DISMISS_ACTION_ID) return element.value;
  }
  return undefined;
}

/**
 * メッセージのblocksから、クリップ1件ぶんのブロックの組とそのパスを取り出す。
 *
 * 1件が複数ブロックに散るため、`block_id`の接頭辞で組をまとめる。
 * パスはボタンの`value`にしか無いので、組の中から拾う。
 */
function clipGroups(blocks: AnyMessageBlock[]): ClipGroup[] {
  const groups = new Map<string, ClipGroup>();
  for (const block of blocks) {
    const id = block.block_id?.match(/^(clip-\d+)(?:-|$)/)?.[1];
    if (!id) continue;
    const group = groups.get(id) ?? { path: '', blocks: [] };
    group.blocks.push(block);
    group.path = dismissValue(block) ?? group.path;
    groups.set(id, group);
  }
  return [...groups.values()].filter((group) => group.path);
}

/**
 * 残す組だけにして組み直す。
 *
 * 行そのものはSlackのpayloadに入っているものをそのまま使い、作り直さない。
 * D1から作り直すと、ボタンを1回押すたびに残り全件のサムネイルを取り直すことになる。
 * 見出しだけは残り件数を持つので付け替える。
 */
export function keepClipBlocks(
  blocks: AnyMessageBlock[],
  keep: ReadonlySet<string>,
): AnyMessageBlock[] {
  const kept = clipGroups(blocks).filter((group) => keep.has(group.path));
  return [...headBlocks(kept.length), ...kept.flatMap((group) => group.blocks)];
}

/**
 * ダイジェストの内容をスレッドの会話へ残す（ADR 0010）。
 * これがあるので「3番目のやつ片付けて」と言われた対象をAIが特定でき、一覧用のツールが要らない。
 *
 * 何が起点でこの一覧が出たのかを先に置き、履歴を他のターンと同じ user → assistant の形に保つ。
 */
function digestTurn(clips: DigestClip[]): ModelMessage[] {
  const lines = clips.map((clip, index) => `${index + 1}. ${clipTitle(clip)}（${clip.path}）`);
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
  const slack = new SlackAPIClient(env.SLACK_BOT_TOKEN);
  const clips = await selectDigestClips(env);
  const shown = await withUsableThumbnails(clips);
  // cronで動く`scheduled`にはSlackのイベントが無く、投稿先の`channel`が手元に無い。
  // 既に開いているDMなら同じIDが返るだけで、新しい会話は作られない（`im:write`が要る）。
  const opened = await slack.conversations.open({ users: env.SLACK_ALLOWED_USER_ID });
  const channel = opened.channel?.id;
  if (!channel) throw new Error('Slack conversations.open returned no channel');
  const at = now.toISOString();
  const { ts } = await slack.chat.postMessage({
    channel,
    text: digestText(shown.length),
    blocks: digestBlocks(env, shown),
    unfurl_links: false,
    unfurl_media: false,
  });
  await markDigestShown(
    env,
    shown.map((clip) => clip.path),
    at,
  );
  // 0件のときは会話へ残す中身が無い。投稿自体は「今週は片付いている」を伝えるために行う。
  if (shown.length === 0) return;
  const thread = env.THREAD.get(env.THREAD.idFromName(`${channel}:${ts}`));
  await thread.append(digestTurn(shown).map((message) => JSON.stringify(message)));
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
  target: { path: string; channel: string; messageTs: string; blocks: AnyMessageBlock[] },
): Promise<void> {
  await setClipDismissed(env, target.path, true, new Date().toISOString());
  const groups = clipGroups(target.blocks);
  const alive = await selectUndismissed(
    env,
    groups.map((group) => group.path),
  );
  await new SlackAPIClient(env.SLACK_BOT_TOKEN).chat.update({
    channel: target.channel,
    ts: target.messageTs,
    text: digestText(groups.filter((group) => alive.has(group.path)).length),
    blocks: keepClipBlocks(target.blocks, alive),
  });
}
