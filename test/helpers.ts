import { env as testEnv } from 'cloudflare:test';
// 本番と同じ定義でテストする。テーブル定義をここへ書き写すと、片方だけが変わる。
import schema from '../schema.sql?raw';
import type { ThreadAgent } from '../src/thread';
import type { ToolState } from '../src/tool-state';
import type { ChatJob, Env, TranslateJob } from '../src/types';

let toolOwnerSequence = 0;
let toolOwnerId = 'test-owner-0';

/**
 * D1のテーブルを用意して空にする。
 * vitest-pool-workersはテストごとにストレージを巻き戻すので、beforeEachで呼ぶ。
 */
export async function resetClips(): Promise<void> {
  toolOwnerId = `test-owner-${++toolOwnerSequence}`;
  // `exec`は改行で文を割るため、複数行のDDLには使えない。コメントだけ落として1文として流す。
  await testEnv.CLIPS.prepare(schema.replace(/--[^\n]*/g, '')).run();
  await testEnv.CLIPS.prepare('DELETE FROM clips').run();
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CLIP_QUEUE: { send: async (_job: ChatJob) => undefined } as unknown as Queue<ChatJob>,
    TRANSLATE_QUEUE: {
      send: async (_job: TranslateJob) => undefined,
    } as unknown as Queue<TranslateJob>,
    THREAD: {
      idFromName() {
        throw new Error('THREAD was used without a stub in this test');
      },
    } as unknown as DurableObjectNamespace<ThreadAgent>,
    TOOL_STATE: testEnv.TOOL_STATE as DurableObjectNamespace<ToolState>,
    CLIPS: testEnv.CLIPS,
    AI_GATEWAY_ID: 'reading-clipper-summarizer',
    // ここだけは`wrangler.jsonc`の`vars`から取る。google_searchと保存のツールの併用を守る
    // 回帰テストは、実際にデプロイされるモデル名で走らないと意味がない（ADR 0009）。
    AI_MODEL: testEnv.AI_MODEL,
    TOOL_OWNER_ID: toolOwnerId,
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    SLACK_SIGNING_SECRET: 'test-signing-secret',
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_ALLOWED_TEAM_ID: 'T_ALLOWED',
    SLACK_ALLOWED_USER_ID: 'U_ALLOWED',
    AI_GATEWAY_TOKEN: 'test-aig-token',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'unused',
    GITHUB_INSTALLATION_ID: '67890',
    GITHUB_REPO: 'example/clips',
    FIRECRAWL_API_KEY: 'fc-test',
    X_BEARER_TOKEN: 'x-test',
    ...overrides,
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SLACK_API = 'https://slack.com/api/';

/**
 * モックしたfetchへ来たものがSlack API呼び出しなら、メソッド名とフォーム本文を返す。
 *
 * Slack APIクライアントは`fetch(new Request(...))`と1引数で呼ぶため、URLも本文も
 * `init`ではなくRequestから読む。本文はform urlencodedで、blocksのような配列は
 * 1フィールドにJSONで入るのでここで戻す。
 */
export async function readSlackCall(
  input: RequestInfo | URL,
): Promise<{ method: string; params: Record<string, unknown> } | undefined> {
  if (!(input instanceof Request) || !input.url.startsWith(SLACK_API)) return undefined;
  // workerdは`.text()`をform urlencodedに対して警告するため、バイト列から自分で起こす。
  const body = new TextDecoder().decode(await input.arrayBuffer());
  const params: Record<string, unknown> = Object.fromEntries(new URLSearchParams(body));
  if (typeof params.blocks === 'string') params.blocks = JSON.parse(params.blocks) as unknown[];
  return { method: input.url.slice(SLACK_API.length), params };
}

/**
 * slack-edgeはハンドラを呼ぶ前に`auth.test`で自分のbot IDを引き、自分が出した投稿の
 * イベントを落とす判定に使う。`bot_id`を欠くとイベント側の欠けたそれと一致してしまい、
 * 本物のDMまで自己イベント扱いで消える。
 */
export function slackAuthTestResponse(): Response {
  return jsonResponse({ ok: true, user_id: 'U_BOT', bot_id: 'B_BOT', team_id: 'T_ALLOWED' });
}

/**
 * 記事ページのHTML応答。
 * `landedAt`を渡すとリダイレクトを追った後の応答になる。`new Response()`の`url`は常に
 * 空文字なので、着いた先を見せるにはこうして差し込むしかない。
 */
export function htmlResponse(head: string, status = 200, landedAt?: string): Response {
  const response = new Response(`<html><head>${head}</head><body>本文</body></html>`, {
    status,
    headers: { 'content-type': 'text/html' },
  });
  if (landedAt) Object.defineProperty(response, 'url', { value: landedAt });
  return response;
}

/**
 * GeminiのgenerateContent応答。partsにテキストかfunctionCallを並べる。
 * `candidate` はcandidates[0]へマージする（groundingMetadataを足すため）。
 */
export function modelResponse(parts: unknown[], candidate: Record<string, unknown> = {}): Response {
  return jsonResponse({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...candidate }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

export async function generateGitHubAppKeyPair(): Promise<{
  privateKeyPem: string;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  const der = new Uint8Array(exported);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).match(/.{1,64}/g)?.join('\n') ?? '';
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

export async function generatePrivateKeyPem(): Promise<string> {
  return (await generateGitHubAppKeyPair()).privateKeyPem;
}

async function signedSlackPost(
  path: string,
  body: string,
  contentType: string,
  signingSecret: string,
): Promise<Request> {
  const timestamp = String(Math.floor(Date.now() / 1000));
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
  const signature = `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}

/** Event SubscriptionsとInteractivity & Shortcutsは同じRequest URLへ届く（ADR 0014）。 */
const SLACK_EVENTS_PATH = '/slack/events';

export async function signedSlackRequest(
  payload: unknown,
  signingSecret = 'test-signing-secret',
): Promise<Request> {
  return signedSlackPost(
    SLACK_EVENTS_PATH,
    JSON.stringify(payload),
    'application/json',
    signingSecret,
  );
}

/** インタラクティブpayloadはJSONではなく`payload=`のform urlencodedで届く。 */
export async function signedInteractivityRequest(
  payload: unknown,
  signingSecret = 'test-signing-secret',
): Promise<Request> {
  return signedSlackPost(
    SLACK_EVENTS_PATH,
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    'application/x-www-form-urlencoded',
    signingSecret,
  );
}
