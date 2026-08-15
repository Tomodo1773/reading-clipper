export type ClipSource = 'qiita' | 'zenn' | 'x' | 'web';

/** SlackからQueueへ渡す、1件ぶんのクリップ処理。 */
export interface ClipJob {
  version: 1;
  /** Slack Events APIのevent_id。再送時の冪等キーとして使う。 */
  jobId: string;
  url: string;
  slackChannel: string;
  slackThreadTs: string;
  receivedAt: string;
  /** 1通に複数URLが含まれていた場合、処理しなかった件数。 */
  ignoredUrlCount: number;
}

export interface FetchedContent {
  canonicalUrl: string;
  source: ClipSource;
  title: string;
  author?: string;
  publishedAt?: string;
  markdown: string;
  complete: boolean;
}

/** Worker bindingsとsecrets。実値は公開リポジトリへ置かない。 */
export interface Env {
  // wrangler.jsonc由来
  CLIP_QUEUE: Queue<ClipJob>;
  AI_GATEWAY_ID: string;
  AI_MODEL: string;

  // secrets
  CLOUDFLARE_ACCOUNT_ID: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  /** Slack Appを許可するワークスペースのteam_id。 */
  SLACK_ALLOWED_TEAM_ID: string;
  /** 許可するSlack user_id。空欄は全拒否。 */
  SLACK_ALLOWED_USER_ID: string;
  AI_GATEWAY_TOKEN: string;
  GITHUB_APP_ID: string;
  /** GitHub AppのPKCS#8 PEM形式private key。 */
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  /** `owner/repo`形式。 */
  GITHUB_REPO: string;
  FIRECRAWL_API_KEY: string;
  X_BEARER_TOKEN: string;
}
