# Reading Clipper

SlackへURLを送るだけで、記事の保存・要約・再発見までをまとめて扱える個人用リーディングクリッパー。

![Reading Clipperのシステム構成](docs/architecture/architecture.svg)

## 概要

Reading Clipperは、アプリやブラウザの共有メニューからSlackへ送ったURLを読み取り、Markdownとしてprivate GitHubリポジトリへ保存するサービスです。保存直後にAIが内容を短く要約し、同じSlackスレッドで記事について質問できます。

まだ片付けていないクリップは毎週Slackへ再掲されるため、保存したまま忘れがちな記事にも自然に戻れます。専用のWeb画面はなく、クリップ、会話、整理の操作がSlackだけで完結します。

## 開発の背景

読みたい技術記事はZenn、X、Qiitaなど複数のプラットフォームに散らばり、それぞれのブックマークへ保存すると一覧性がなくなります。さらに、保存した記事が再び目に入る機会がなく、積読になりがちでした。

そこで、入口を普段使っているSlackへ一本化し、本文はGitHubへ蓄積、AIによる要約と週次ダイジェストで読むきっかけを作るサービスとして開発しました。通常のWeb取得では扱いづらいXの公開PostをAPI経由で読めることも、個人用ツールとして重視しています。

## 主な機能

- **Slackからすぐにクリップ**
  スマートフォンのアプリやブラウザの共有メニューから、URLをSlack AppのDMへ送るだけで受け付けます。
- **URLに応じた本文取得**
  Qiita、Zenn、Xの公開Post、一般のWebページをそれぞれに適した方法で取得します。リダイレクトURLにも対応します。
- **紹介投稿から本命の記事を保存**
  Xの短い投稿がブログ記事を紹介している場合、AIが投稿本文を読んだうえでリンク先も取得し、紹介投稿ではなく記事本体をクリップします。
- **要約とスレッド内の質問応答**
  保存時に1〜2文で要約し、続けて質問すると取得済みの本文を踏まえて回答します。同じスレッドでは記事を取り直しません。
- **MarkdownをGitHubへ保存**
  記事本文と出典情報をMarkdownへ整え、GitHub App経由で指定したprivateリポジトリへ保存します。
- **週次ダイジェストと片付け**
  毎週日曜9時（JST）に、まだ片付けていないクリップを最大7件Slackへ投稿します。各記事はボタンまたはスレッド内の自然文で片付けられます。

## 主な特徴・設計上のポイント

### Slackだけで完結

専用のWeb UIを持たず、保存、要約、記事についての会話、週次通知、片付けまでをSlackへ集約しています。新しい操作画面を覚えたり、一覧を見に行ったりする必要がありません。

### Cloudflare Workersによる軽快な応答

常駐サーバーを持たず、Cloudflare Workers、Queues、Durable Objects、D1を組み合わせています。Workersの短いコールドスタートを活かし、個人利用では無料枠を中心にしながら体感速度を損なわない構成を狙っています。

Slack Events APIへの応答は受付処理だけに限定し、本文取得、AI処理、GitHub保存はQueueへ渡します。時間のかかる処理からSlackの3秒制限を切り離しています。

### 用途ごとに状態の置き場所を分離

- 記事本文の正本はprivate GitHubリポジトリに置く
- Slackスレッドごとの会話履歴はDurable Objectsに置く
- 週次ダイジェストの「片付けたか」と表示履歴はD1に置く

D1は厳密な既読・未読管理ではなく、GitHub上のクリップへ付ける軽量な注釈レイヤーです。失われてもGitHubのMarkdownから再構成できます。

## システム構成

構成図は静的な依存関係を示しています。矢印は主要な連携を表し、完全なリクエスト・レスポンスの時系列ではありません。

受付、Queue処理、週次cronは1つのCloudflare Workerへ同居させています。AI Gateway経由でGeminiを呼び、記事本文はGitHub、会話履歴はDurable Objects、ダイジェスト用の状態はD1へ保存します。

構成図の編集元とアイコンの出典は[`docs/architecture/`](docs/architecture/)にあります。

## 技術スタック

| 分類 | 技術 | 役割 |
| --- | --- | --- |
| 言語 | TypeScript | Worker、取得処理、GitHub連携 |
| HTTP | Hono | Slack Events API、Interactivity、health check |
| 実行基盤 | Cloudflare Workers | HTTP受付、Queue consumer、scheduled handler |
| 非同期処理 | Cloudflare Queues | Slack受付と本文取得・AI処理を分離 |
| 会話状態 | Cloudflare Durable Objects | Slackスレッド単位の会話履歴 |
| ダイジェスト状態 | Cloudflare D1 / Cron Triggers | 片付け状態、再掲履歴、週次実行 |
| AI | Vercel AI SDK / Gemini / Cloudflare AI Gateway | 要約、質問応答、保存対象の判断 |
| 本文取得 | Qiita Markdown / Zenn API / X API / Firecrawl | URLごとの本文取得 |
| 保存 | GitHub App / Contents API | privateリポジトリへのMarkdown保存 |
| テスト | Vitest / Cloudflare Workers test pool | Worker環境でのユニットテスト |

## セットアップ

### 前提

- Node.js 22
- `package.json`で固定されたpnpm
- Socket Firewall（依存関係の取得時に使用）
- Cloudflare、Slack App、GitHub App、Gemini API、Firecrawl、X APIの各アカウント

### ローカル開発

```powershell
sfw pnpm install
pnpm wrangler d1 execute reading-clipper-clips-db --local --file=./schema.sql
pnpm dev
```

Slack連携を含めて動かすには、`wrangler.jsonc`に定義されたQueue、Durable Objects、D1、Cron Triggers、AI Gatewayと、次のWorker Secretsが必要です。最新の一覧と用途は[`src/types.ts`](src/types.ts)の`Env`を参照してください。

```text
CLOUDFLARE_ACCOUNT_ID
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
SLACK_ALLOWED_TEAM_ID
SLACK_ALLOWED_USER_ID
AI_GATEWAY_TOKEN
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_INSTALLATION_ID
GITHUB_REPO
FIRECRAWL_API_KEY
X_BEARER_TOKEN
```

Secretは個別に登録します。

```powershell
pnpm wrangler secret put <NAME>
```

AI Gatewayの作成・更新には、`AI Gateway Read`と`AI Gateway Write`権限を持つCloudflare API tokenを環境変数へ設定し、次を実行します。

```powershell
pnpm setup:aigw
```

Slack AppはDMの`message.im`をEvents APIで受信し、Interactivityでダイジェストのボタンを処理します。Request URLはそれぞれ`/slack/events`と`/slack/interactivity`です。GitHub Appには保存先リポジトリだけを対象とした`Contents: Read and write`権限を与えます。

### 検証

```powershell
pnpm test
pnpm typecheck
pnpm wrangler deploy --dry-run
```

## 制約

- 単一のSlackワークスペースとユーザーをallowlistで許可する個人利用向けです。
- XはAPIから取得できる公開Postだけを対象とし、protected contentは保存しません。
- 週次ダイジェストは「読んだか」ではなく「片付けたか」だけを管理します。
- 保存先はprivate GitHubリポジトリを前提とし、取得した本文を外部へ再配布しません。

## 設計判断

主要な設計判断と代替案は[`docs/adr/`](docs/adr/)に記録しています。

- [Slackの入力をすべてAIへ渡し、保存をツールにする](docs/adr/0006-agent-with-save-tool.md)
- [スレッドの会話履歴をDurable Objectsに保存する](docs/adr/0007-thread-history-in-durable-object.md)
- [週次ダイジェストと片付け状態をD1で管理する](docs/adr/0010-weekly-digest-and-dismiss-bit.md)
- [本文を読んでからAIが保存対象を決める](docs/adr/0012-load-content-then-save-loaded.md)
