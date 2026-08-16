import { env as testEnv } from 'cloudflare:test';
import type { ThreadAgent } from '../src/thread';
import type { ChatJob, Env } from '../src/types';

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CLIP_QUEUE: { send: async (_job: ChatJob) => undefined } as unknown as Queue<ChatJob>,
    THREAD: {
      idFromName() {
        throw new Error('THREAD was used without a stub in this test');
      },
    } as unknown as DurableObjectNamespace<ThreadAgent>,
    AI_GATEWAY_ID: 'reading-clipper-summarizer',
    // ここだけは`wrangler.jsonc`の`vars`から取る。google_searchとsave_clipの併用を守る
    // 回帰テストは、実際にデプロイされるモデル名で走らないと意味がない（ADR 0009）。
    AI_MODEL: testEnv.AI_MODEL,
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

export async function signedSlackRequest(
  payload: unknown,
  signingSecret = 'test-signing-secret',
): Promise<Request> {
  const body = JSON.stringify(payload);
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
  return new Request('https://worker.example/slack/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}
