import { ClipError, isRetryableStatus } from './errors';
import { asRecord, fetchWithTimeout, sha256Bytes, stringField } from './utils';

export async function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!timestamp || !signature || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > 300) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`)),
  );
  const expected = `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  let difference = expected.length ^ signature.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ (signature.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function deterministicUuid(seed: string): Promise<string> {
  const bytes = (await sha256Bytes(seed)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** okErrorsに挙げたSlack APIエラーは失敗として扱わない（その場合は応答を返さない）。 */
async function callSlackApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  okErrors: readonly string[] = [],
): Promise<Record<string, unknown> | undefined> {
  const response = await fetchWithTimeout(
    `https://slack.com/api/${method}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    },
    10_000,
    'slack',
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const record = asRecord(payload);
  if (response.ok && record?.ok === true) return record;

  const apiError = stringField(record, 'error') ?? `HTTP ${response.status}`;
  if (okErrors.includes(apiError)) return undefined;
  throw new ClipError(
    `Slack ${method} failed: ${apiError}`,
    'slack',
    response.status === 200 || isRetryableStatus(response.status),
    response.status,
  );
}

/**
 * 投稿したメッセージのtsを返す。
 * 週次ダイジェストはこのtsをスレッドのキーにするため、返り値が要る（ADR 0010）。
 */
export async function postSlackMessage(options: {
  token: string;
  channel: string;
  /** 省略するとチャンネル直下へ投稿する。 */
  threadTs?: string;
  /** blocksを付けたときも通知とアクセシビリティのために必ず入れる。 */
  text: string;
  blocks?: unknown[];
  /**
   * 同じ処理が再実行されうる経路にだけ渡す（ADR 0011）。
   *
   * 渡すとSlackは同じキーの投稿を重複と見なし、新しいメッセージを作らずに既存のtsを返す。
   * 再試行の無い経路で渡すと、投稿できていないのに成功として返るだけになる。
   * 呼び出し側はこの2つを区別できないので、再試行がある経路以外では渡さない。
   */
  idempotencyKey?: string;
}): Promise<string> {
  const result = await callSlackApi('chat.postMessage', options.token, {
    channel: options.channel,
    thread_ts: options.threadTs,
    text: options.text,
    blocks: options.blocks,
    ...(options.idempotencyKey
      ? { client_msg_id: await deterministicUuid(options.idempotencyKey) }
      : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
  const ts = stringField(result, 'ts');
  if (!ts) throw new ClipError('Slack chat.postMessage returned no ts', 'slack', true);
  return ts;
}

/** ダイジェストから片付けた行を落とすために、投稿済みメッセージを差し替える。 */
export async function updateSlackMessage(options: {
  token: string;
  channel: string;
  ts: string;
  text: string;
  blocks: unknown[];
}): Promise<void> {
  await callSlackApi('chat.update', options.token, {
    channel: options.channel,
    ts: options.ts,
    text: options.text,
    blocks: options.blocks,
  });
}

/**
 * ユーザーとのDMを開いてチャンネルIDを返す。
 *
 * cronで動く`scheduled`にはSlackのイベントが無く、投稿先の`channel`が手元に無い。
 * 既に開いているDMなら同じIDが返るだけで、新しい会話は作られない。
 * この呼び出しのためにBot Token Scopeへ`im:write`が要る。
 */
export async function openSlackDirectMessage(token: string, userId: string): Promise<string> {
  const result = await callSlackApi('conversations.open', token, { users: userId });
  const channel = stringField(asRecord(result?.channel), 'id');
  if (!channel) throw new ClipError('Slack conversations.open returned no channel', 'slack', true);
  return channel;
}

/** Slackのイベント再送で同じ絵文字を2度付けにいくため、already_reactedは成功として扱う。 */
export async function addSlackReaction(options: {
  token: string;
  channel: string;
  timestamp: string;
  name: string;
}): Promise<void> {
  await callSlackApi(
    'reactions.add',
    options.token,
    {
      channel: options.channel,
      timestamp: options.timestamp,
      name: options.name,
    },
    ['already_reacted'],
  );
}
