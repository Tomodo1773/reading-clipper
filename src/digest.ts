import type { ModelMessage } from 'ai';
import { type AnyMessageBlock, type SectionBlock, SlackAPIClient } from 'slack-edge';
import { type DigestClip, markDigestShown, selectDigestClips } from './clips';
import { clipBlockId, dismissActionBlock } from './dismiss';
import type { Env } from './types';
import { fetchWithTimeout } from './utils';

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

/**
 * 「未読」と呼ばない。記録しているのは片付けたかどうかだけである（ADR 0010）。
 *
 * 件数は持たない。ボタンを押すたびに数え直すことになるうえ、投稿時点の件数は
 * 通知に出る`digestText`が既に持っている（ADR 0015）。
 */
function headBlocks(count: number): AnyMessageBlock[] {
  const header: AnyMessageBlock = {
    type: 'header',
    text: { type: 'plain_text', text: 'まだ片付いていないクリップ' },
  };
  if (count === 0) {
    return [header, { type: 'section', text: { type: 'mrkdwn', text: 'いまは残っていないわ。' } }];
  }
  return [header, { type: 'divider' }];
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
  const id = clipBlockId(index);
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
    dismissActionBlock(index, clip.path),
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
