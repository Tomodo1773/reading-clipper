# Reading Clipper

SlackにURLを送るだけで、記事を保存し、AIと内容を掘り下げ、あとで読み返すための個人用リーディングクリッパー。

![Bot/Core Workerの内部構成](docs/architecture/architecture.svg)

## 概要

Reading Clipperは、SlackのDMへ送ったURLを読み取り、本文をMarkdownとしてprivate GitHubリポジトリへ保存するサービス。保存時にAIが短く要約し、同じスレッドで記事について質問できる。Slack以外のMCPクライアントからも同じクリップ操作を使える。Xの公開Post、arXivの論文、スライドなども専用の取得経路で扱い、保存後に日本語訳を生成する。まだ片付けていないクリップは、Webの一覧と週次Slackダイジェストから見直せる。

## 開発の背景

読みたい技術記事はZenn、X、Qiitaなど複数のプラットフォームに散らばり、サービスごとのブックマークでは一覧性がない。保存した記事が再び目に入らず、積読になりやすい。

入口を普段使うSlackへ集約し、本文をGitHubへ蓄積し、AIとの会話と週次ダイジェストで読み返すきっかけを作るサービスとして開発した。通常のページ取得では扱いづらいXの公開Postも保存対象に含める。

## 主な機能

- **Slackから登録し、そのままAIと対話**
  SlackのDMへURLを送るだけで、本文の取得、保存、要約まで進む。続けて同じスレッドで質問すると、取得済みの本文を根拠に内容を掘り下げられる。保存したクリップも会話から探して読み返せる。

- **MCPクライアントからも利用**
  保存、検索、本文の読み取り、削除などの操作をremote MCPとして提供する。Slack以外のMCPクライアントからも、同じCoreの機能を利用できる。

- **URLの種類に応じた本文取得**
  Qiita、Zenn、Xの公開Post、arXiv、Speaker Deck、ドクセル、一般のWebページに対応する。XはX API、arXivはLaTeXMLの全文HTML、スライドは公開されているテキストを使うため、通常のページ取得だけでは扱いにくい内容もクリップできる。

- **本文をMarkdownとして保存し、長文も日本語で読む**
  記事本文と出典情報をprivate GitHubリポジトリへ保存する。日本語以外の本文は保存後に非同期で翻訳し、段落や見出しの区切りを保ったMarkdownへ置き換える。コード、数式、URLなどは原文のまま残るため、ブラウザ上の翻訳で表示構造が崩れる問題を避けられる。

- **Webで一覧、本文の閲覧、片付け**
  認証付きのWebページで、まだ片付けていないクリップを全件、サムネイル・抜粋・保存日とともに確認できる。保存済みMarkdownを本文ページで読み、カードのボタンから1件ずつ片付けられる。片付け済みのクリップも軽い一覧から読み返せる。

- **週次ダイジェストで再発見**
  まだ片付けていないクリップを毎週Slackへ再掲する。ダイジェストには最大7件を載せ、各項目から元記事と保存済みMarkdownへ移動できる。片付ける操作もその場で完了する。

## 主な特徴・設計上のポイント

### MCPでSlack以外からも使う

Slack Botと同じCoreの機能を、Streamable HTTPのremote MCPとして公開する。MCP Edgeは公開境界と認証結果の受け渡しだけを持ち、実処理はService Binding RPCでCoreへ渡す。Cloudflare Access Managed OAuthへ認証を任せるため、このWorkerにOAuthサーバーやDynamic Client Registration（DCR）を自前実装せず、標準OAuthに対応したMCPクライアントから接続しやすい構成。

### Slackの受付と長い処理をQueueで分離する

Slack Events APIの受付では、3秒制限に収まるようQueueへ登録するところまでを行う。本文取得、AI処理、GitHub保存はQueue consumerで実行し、保存後の翻訳は別のQueueへ分ける。外部サービスの応答待ちや再試行をSlackの受付から切り離す構成。

### URL種別ごとに取得経路を選ぶ

リダイレクト先を確定してからURLの種類を判定し、QiitaはMarkdown、Zennは専用API、XはX API、arXivはLaTeXMLの全文HTML、Speaker Deckとドクセルは構造化データから本文を組み立てる。それ以外のWebページはFirecrawlで取得し、各経路の結果を共通のMarkdownへそろえる。

## システム構成

上の構成図はBot/Core Workerの主要な連携を示す。Slack受付とQueue処理、週次cronをWorkersで動かし、AI Gateway経由のGemini、GitHub、Durable Objects、D1を組み合わせる。MCP EdgeとWeb Workerは同じCoreへService Binding RPCで接続する。

構成図の編集元とアイコンの出典は[`docs/architecture/`](docs/architecture/)にある。

## 技術スタック

| 分類 | 技術 | 役割 |
| --- | --- | --- |
| 言語 | TypeScript | Worker、本文取得、GitHub連携 |
| Slack | slack-edge | Events API、DM、Interactivity |
| MCP | MCP TypeScript SDK | 外部MCPクライアント向けのStreamable HTTP |
| 実行基盤 | Cloudflare Workers | HTTP受付、Queue consumer、scheduled handler |
| 非同期処理 | Cloudflare Queues | Slack受付と本文処理、保存後の翻訳を分離 |
| 会話・参照状態 | Cloudflare Durable Objects | Slackスレッドの会話履歴、ツール参照の保持 |
| 読書状態 | Cloudflare D1 / Cron Triggers | 片付け状態、ダイジェストの表示履歴、週次実行 |
| AI | Vercel AI SDK / Gemini / Cloudflare AI Gateway | 要約、質問応答、保存対象の判断、翻訳 |
| 本文取得 | Qiita / Zenn / X / arXiv / Speaker Deck / ドクセル / Firecrawl | URLごとの本文取得 |
| 保存 | GitHub App / Contents API | privateリポジトリへのMarkdown保存 |
| 表示 | marked | 保存済みMarkdownのHTML化 |
| テスト | Vitest / Cloudflare Workers test pool | Worker環境でのテスト |

## セットアップ

### 前提

- Node.js 22
- `package.json`で固定されたpnpm
- 依存取得に使うSocket Firewall（`sfw`）
- Cloudflare、Slack App、GitHub App、Gemini、Firecrawl、X APIの利用環境

### ローカル開発

```powershell
sfw pnpm install
pnpm wrangler d1 execute reading-clipper-clips-db --local --file=./schema.sql
pnpm dev
```

ローカルのsecretは`.dev.vars`から読み込む。必要な名前は[`src/types.ts`](src/types.ts)の`Env`に定義する。

### 検証

```powershell
sfw pnpm test
sfw pnpm typecheck
sfw pnpm dry-run
```

## 制約

- 単一のSlackワークスペースとユーザーを対象にした個人利用向け。
- XはAPIから取得できる公開Postだけを対象にする。
- スライドは公開されたテキストの範囲で保存する。
- 保存先はprivate GitHubリポジトリを前提とし、閲覧ページも本人向けに保護する。
- 週次ダイジェストが扱うのは「読んだか」ではなく「片付けたか」の状態。

## 設計判断

設計判断の背景、代替案、採用による制約は[`docs/adr/`](docs/adr/)に記録する。
