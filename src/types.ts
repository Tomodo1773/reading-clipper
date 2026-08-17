import type { ThreadAgent } from './thread';

export type ClipSource = 'qiita' | 'zenn' | 'x' | 'web';

/**
 * SlackからQueueへ渡す、1通ぶんの会話。
 * URLの有無で分岐せず、届いたメッセージをそのまま渡す（ADR 0006）。
 */
export interface ChatJob {
  version: 2;
  /** Slack Events APIのevent_id。再送とQueue再試行の冪等キーとして使う。 */
  jobId: string;
  text: string;
  slackChannel: string;
  /** 返信先スレッドの親ts。会話状態のキーでもある（ADR 0007）。 */
  slackThreadTs: string;
  receivedAt: string;
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
  CLIP_QUEUE: Queue<ChatJob>;
  /** スレッド単位の会話状態。`{channel}:{thread_ts}` で引く。 */
  THREAD: DurableObjectNamespace<ThreadAgent>;
  /** 読書状態。GitHubに対する注釈レイヤーで、母集団の正本ではない（ADR 0010）。 */
  CLIPS: D1Database;
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
