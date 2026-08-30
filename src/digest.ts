import type { ModelMessage } from 'ai';
import { type AnyMessageBlock, type SectionBlock, SlackAPIClient } from 'slack-edge';
import {
  clipTitle,
  deleteClip,
  DIGEST_SIZE,
  type DigestClip,
  markDigestShown,
  selectDigestClips,
} from './clips';
import { clipBlockId, dismissButton } from './dismiss';
import { asClipError } from './errors';
import { getGitHubFile } from './github';
import type { Env } from './types';
import { fetchWithTimeout } from './utils';

/** Slackの`image_url`の上限。Qiitaの自動生成OGPは2600文字を超える実例がある。 */
const MAX_IMAGE_URL_CHARS = 3000;

/** Slackが受け付ける画像形式。これ以外を渡すと投稿ごと拒否される。 */
const IMAGE_CONTENT_TYPE = /^image\/(?:png|jpeg|jpg|gif)\b/i;

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
 * 1件を本文section（タイトル・抜粋・サムネイル）+ メタ情報section（ボタンをaccessory）の
 * 2ブロックで表す（ADR 0028）。本文側はADR 0011のまま触らず、ボタンだけを独立した
 * actions行からメタ情報の右へ下げる。
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
  const metaSection: SectionBlock = {
    type: 'section',
    block_id: `${id}-meta`,
    // clipped_atは必須だが、壊れた日時でもSlackへ空文字を渡さないための最後のフォールバック。
    text: { type: 'plain_text', text: meta || '保存済み' },
    accessory: dismissButton(clip.path),
  };
  return [
    section,
    // mrkdwnにするとSlackがホスト名をリンクへ変える。書式は要らないのでplain_textにする。
    metaSection,
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
 * GitHubに正本が残っているクリップだけを残す（ADR 0018）。消えていた行は台帳から落とす。
 *
 * ADR 0016でSlackから消せるようになったが、GitHub上で直接消す経路は残る。そちらで消しても
 * 台帳には行が残り、ダイジェストのリンク先は記事のcanonical URLなので、出してしまうと
 * 利用者からは生きているクリップと見分けが付かない。
 *
 * 台帳全体をGitHubと突き合わせないのは、孤児行が害をなすのが出た瞬間だけだからである。
 *
 * 削除は`markDigestShown`と違って投稿の成否を待たない。提示済みの印は「出せたか」の記録なので
 * 投稿できてから打つが、こちらはGitHubの状態をそのまま写しているだけで、投稿とは関係が無い。
 */
export async function keepExistingClips(env: Env, clips: DigestClip[]): Promise<DigestClip[]> {
  const checked = await Promise.all(
    clips.map(async (clip) => ({ clip, exists: await stillOnGitHub(env, clip.path) })),
  );
  // 消すのはADR 0016と同じ1行ずつの削除。ここで消える件数は多くて数件なので、
  // まとめて消す専用のクエリを別に持たない。
  await Promise.all(
    checked.filter((entry) => !entry.exists).map((entry) => deleteClip(env, entry.clip.path)),
  );
  return checked.filter((entry) => entry.exists).map((entry) => entry.clip);
}

/**
 * GitHubにファイルが残っているか。
 *
 * **falseを返すのは404を見たときだけにする。** 認証の失敗もタイムアウトも5xxも「不明」であって
 * 「無い」ではない。確認できなかったことを削除の根拠にすると、GitHubが不調な週に台帳が削れる。
 * 確認が落ちた週はゴーストが1回出るが、それは次の週に取り返せる。消した行は戻らない。
 */
async function stillOnGitHub(env: Env, path: string): Promise<boolean> {
  try {
    return (await getGitHubFile(env, path)) !== undefined;
  } catch (error) {
    const clipError = asClipError(error, 'github');
    console.warn(
      JSON.stringify({ stage: clipError.stage, message: clipError.message, path }),
    );
    return true;
  }
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
  // 候補は多めに取り、GitHubから消えたものを落としてから7件へ切る（ADR 0018）。
  // サムネイルの検証は投稿する7件にだけ走らせる。
  const candidates = await keepExistingClips(env, await selectDigestClips(env));
  const shown = await withUsableThumbnails(candidates.slice(0, DIGEST_SIZE));
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
