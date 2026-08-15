import { ClipError, isRetryableStatus } from './errors';
import { fetchWithTimeout, sha256Bytes } from './utils';

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

export async function postSlackMessage(options: {
  token: string;
  channel: string;
  threadTs: string;
  text: string;
  idempotencyKey: string;
}): Promise<void> {
  const response = await fetchWithTimeout(
    'https://slack.com/api/chat.postMessage',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: options.channel,
        thread_ts: options.threadTs,
        text: options.text,
        client_msg_id: await deterministicUuid(options.idempotencyKey),
        unfurl_links: false,
        unfurl_media: false,
      }),
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
  const ok = typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true;
  if (!response.ok || !ok) {
    const apiError =
      typeof payload === 'object' && payload !== null && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `HTTP ${response.status}`;
    throw new ClipError(
      `Slack reply failed: ${apiError}`,
      'slack',
      response.status === 200 || isRetryableStatus(response.status),
      response.status,
    );
  }
}
