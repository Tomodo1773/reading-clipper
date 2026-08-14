/**
 * Queueに載せる1件ぶんのクリップ処理。
 * 受付Workerが登録し、処理Worker（同一Workerのqueueハンドラー）が受け取る。
 */
export interface ClipJob {
  /** 保存対象のURL。取得方法の振り分けは処理側で行う。 */
  url: string;
  /** 要約と保存結果を返す先。 */
  slackChannel: string;
  /** スレッドに返す場合の親メッセージ。 */
  slackThreadTs?: string;
  /** 受付時刻（ISO 8601）。 */
  receivedAt: string;
}

/**
 * Workerのbindingsとsecrets。
 *
 * `AI_GATEWAY_ID` と `CLIP_QUEUE` は wrangler.jsonc が定義する。
 * それ以外はすべて `wrangler secret put <NAME>` で登録するもので、
 * リポジトリにも wrangler.jsonc にも実値を置かない。
 */
export interface Env {
  // wrangler.jsonc 由来
  CLIP_QUEUE: Queue<ClipJob>;
  AI_GATEWAY_ID: string;

  // secrets
  /** AI Gateway URLの組み立てに必要。公開リポジトリに置けないためsecret扱いにする。 */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Slackリクエストの署名検証に使う。 */
  SLACK_SIGNING_SECRET: string;
  /** Slackへの返信に使う。 */
  SLACK_BOT_TOKEN: string;
  /** Authenticated Gatewayの `cf-aig-authorization` に載せる。 */
  AI_GATEWAY_TOKEN: string;
  /** クリップの保存先private repositoryへ書くGitHub App。 */
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  /** `owner/repo` 形式。保存先も環境固有値なのでsecretで渡す。 */
  GITHUB_REPO: string;
  /** 一般WebページのMarkdown取得に使う。 */
  FIRECRAWL_API_KEY: string;
  /** Xの投稿取得に使う。 */
  X_BEARER_TOKEN: string;
}
