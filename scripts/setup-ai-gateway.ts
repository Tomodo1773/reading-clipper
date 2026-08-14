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
const GATEWAY_ID = process.env.AI_GATEWAY_ID ?? 'reading-clipper-summarizer';

/**
 * ゲートウェイの設定。APIは作成・更新のどちらでもこの5つを必須で要求する。
 */
const GATEWAY_CONFIG = {
  // 要約は毎回異なる記事に対して行うため、キャッシュしない。
  cache_invalidate_on_update: false,
  cache_ttl: 0,

  // プロンプトと応答本文を含むログを保存する。要約の入力と出力を追跡するために必要。
  collect_logs: true,

  // レート制限は使わない（0で無効）。
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,

  // cf-aig-authorization ヘッダーを必須にする。
  // トークンは AI Gateway Run 権限のCloudflare API tokenで、別途発行して
  // `wrangler secret put AI_GATEWAY_TOKEN` で登録する。
  authentication: true,

  // 保存上限に達したときに古いログを消す。上限値(log_management)はプランごとに
  // 既定値が異なるため指定せず、Cloudflare側の既定に任せる。
  log_management_strategy: 'DELETE_OLDEST',
};

interface CloudflareError {
  code?: number;
  message?: string;
}

interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: CloudflareError[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。`);
  }
  return value;
}

async function callApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: CloudflareResponse<T> }> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload: CloudflareResponse<T>;
  try {
    payload = JSON.parse(text) as CloudflareResponse<T>;
  } catch {
    throw new Error(`${method} ${path} が非JSONを返しました (${response.status}): ${text}`);
  }

  return { status: response.status, payload };
}

function describeErrors(errors: CloudflareError[] | undefined): string {
  if (!errors || errors.length === 0) {
    return '(詳細なし)';
  }
  return errors.map((e) => `[${e.code ?? '?'}] ${e.message ?? '?'}`).join(', ');
}

async function main(): Promise<void> {
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
  const token = requireEnv('CLOUDFLARE_API_TOKEN');
  const gatewayPath = `/accounts/${accountId}/ai-gateway/gateways`;

  const existing = await callApi(token, 'GET', `${gatewayPath}/${GATEWAY_ID}`);

  if (existing.status === 200 && existing.payload.success) {
    const updated = await callApi(token, 'PUT', `${gatewayPath}/${GATEWAY_ID}`, GATEWAY_CONFIG);
    if (!updated.payload.success) {
      throw new Error(`ゲートウェイの更新に失敗しました: ${describeErrors(updated.payload.errors)}`);
    }
    console.log(`更新しました: ${GATEWAY_ID}`);
  } else if (existing.status === 404) {
    const created = await callApi(token, 'POST', gatewayPath, {
      id: GATEWAY_ID,
      ...GATEWAY_CONFIG,
    });
    if (!created.payload.success) {
      throw new Error(`ゲートウェイの作成に失敗しました: ${describeErrors(created.payload.errors)}`);
    }
    console.log(`作成しました: ${GATEWAY_ID}`);
  } else {
    throw new Error(
      `ゲートウェイの取得に失敗しました (${existing.status}): ${describeErrors(existing.payload.errors)}`,
    );
  }

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
