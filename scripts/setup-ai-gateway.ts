/**
 * AI Gatewayを作成・更新する冪等スクリプト。
 *
 * AI GatewayにはWranglerのコマンドが無く、ダッシュボードかREST APIでしか設定できない。
 * 設定をリポジトリに残すため、ここでコード化してAPIを直接呼ぶ。
 *
 * 実行:
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm setup:aigw
 *
 * 必要なAPI token権限: AI Gateway Read, AI Gateway Write
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * wrangler.jsonc の `vars.AI_GATEWAY_ID` と一致させること。
 * Workerはその値でgateway URLを組み立てる。
 */
const GATEWAY_ID = 'reading-clipper-summarizer';

/**
 * ゲートウェイの設定。
 *
 * cache_ttl と rate_limiting_* はAPIスキーマ上 required かつ nullable で、
 * 「未設定」を表すのは null。0は「0秒」「0リクエスト」という具体的な値なので使わない。
 */
const GATEWAY_CONFIG = {
  // キャッシュもレート制限も使わない。
  cache_invalidate_on_update: false,
  cache_ttl: null,
  rate_limiting_interval: null,
  rate_limiting_limit: null,

  // プロンプトと応答本文を含むログを保存する。要約の入力と出力を追跡するために必要。
  collect_logs: true,

  // cf-aig-authorization ヘッダーを必須にする。
  // トークンは AI Gateway Run 権限のCloudflare API tokenで、別途発行して
  // `wrangler secret put AI_GATEWAY_TOKEN` で登録する。
  authentication: true,

  // 保存上限に達したときに古いログを消す。上限値(log_management)は指定せず
  // Cloudflare側の既定に任せる。
  log_management_strategy: 'DELETE_OLDEST',
};

interface CloudflareResponse {
  success: boolean;
  errors?: { code?: number; message?: string }[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。`);
  }
  return value;
}

async function callApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: CloudflareResponse }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  try {
    return { status: response.status, payload: JSON.parse(text) as CloudflareResponse };
  } catch {
    throw new Error(`${method} ${path} が非JSONを返しました (${response.status}): ${text}`);
  }
}

function describeErrors(payload: CloudflareResponse): string {
  const errors = payload.errors ?? [];
  if (errors.length === 0) {
    return '(詳細なし)';
  }
  return errors.map((e) => `[${e.code ?? '?'}] ${e.message ?? '?'}`).join(', ');
}

async function main(): Promise<void> {
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const gatewayPath = `/accounts/${accountId}/ai-gateway/gateways`;

  const existing = await callApi(token, 'GET', `${gatewayPath}/${GATEWAY_ID}`);

  if (existing.status !== 200 && existing.status !== 404) {
    throw new Error(
      `ゲートウェイの取得に失敗しました (${existing.status}): ${describeErrors(existing.payload)}`,
    );
  }

  const exists = existing.status === 200;
  const result = exists
    ? await callApi(token, 'PUT', `${gatewayPath}/${GATEWAY_ID}`, GATEWAY_CONFIG)
    : await callApi(token, 'POST', gatewayPath, { id: GATEWAY_ID, ...GATEWAY_CONFIG });

  if (!result.payload.success) {
    throw new Error(
      `ゲートウェイの${exists ? '更新' : '作成'}に失敗しました: ${describeErrors(result.payload)}`,
    );
  }
  console.log(`${exists ? '更新' : '作成'}しました: ${GATEWAY_ID}`);

  // トークンの発行はAPIで自動化しない。値は一度しか表示されず、
  // ここで取得するとスクリプトの出力やCIログに残ってしまう。
  console.log(`
次に手動で行うこと:

1. ダッシュボードで ${GATEWAY_ID} の Settings を開き、
   "Create authentication token" で AI Gateway Run 権限のトークンを発行する。
   表示は一度きりなので、その場で控える。

2. Workerへ登録する:
     pnpm wrangler secret put AI_GATEWAY_TOKEN

3. Gemini APIキーをSecrets Storeへ登録する（BYOK）。
   シークレット名は {gateway_id}_{provider_slug}_{alias} 形式が必須:
     ${GATEWAY_ID}_google-ai-studio_default
   登録後はWorkerからproviderのAuthorizationヘッダーが不要になる。
`);
}

await main();
