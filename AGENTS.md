# reading-clipper

## 作業前の確認

作業を始める前に、必ず [`README.md`](README.md) を読み、サービスの目的、機能、構成、制約を確認してください。
設計判断の理由、代替案、その方式で失うものは [`docs/adr/`](docs/adr/) を正本とします。

## リポジトリの前提

- このリポジトリは公開リポジトリです。シークレット、トークン、秘密鍵、実環境固有のドメイン・アカウントID・プロジェクトIDをコミットしないでください。
- Cloudflare、GitHub、Slack、外部APIなどの実値は、環境変数またはGit管理外のローカル設定から渡します。
- README.mdに記載された制約と、関連するADRを実装前に確認してください。
- 依存関係の取得・更新は、Socket Firewall（`sfw`）経由で実行します。lockfileを管理し、CIではlockfileを変更しません。

## モジュール構成

| ファイル | 責務 |
|---|---|
| `src/index.ts` | Slack受付（slack-edge）、Queueへの登録、cronの入口。ここでは積むだけです |
| `src/processor.ts` | Queue consumer。1ジョブの実行とエラーのステージ分類 |
| `src/chat.ts` | AI SDKでのモデル呼び出し1ターン |
| `src/tool-contract.ts` | BotとMCP Edgeで共有するツール名・schema・説明 |
| `src/tools.ts` | 共通ツール処理とAI SDK adapter（読む／保存する／探す／消す） |
| `src/core-rpc.ts` / `src/mcp-edge.ts` | Service Binding RPCと公開`/mcp`境界 |
| `src/tool-state.ts` / `src/retention.ts` | owner単位のopaque refと90日Alarm cleanup |
| `src/thread.ts` | Durable Object。スレッド単位の会話履歴の読み書きだけを持ちます |
| `src/fetchers.ts` | URL種別ごとの本文取得（Qiita / Zenn / X / arXiv / Speaker Deck / ドクセル / Firecrawl）。サイト固有の変換ルールもここに置きます |
| `src/html-markdown.ts` | 意味づけの残るHTMLをMarkdownへ戻す共有の変換器。**特定のサイトを知りません**。サイト固有の要素は呼び出し側からルールとして渡します |
| `src/url.ts` | canonical化、種別判定、保存先パスの決定 |
| `src/github.ts` | GitHub App認証、Code SearchとContents API |
| `src/front-matter.ts` | 保存済みMarkdownのフロントマターをWorkerとバックフィルで共通して読む |
| `src/markdown.ts` | 保存するMarkdownの組み立て |
| `src/clip-index.ts` / `src/clip-index-format.ts` | 新着一覧のGitHub同期と、importなしのMarkdown生成・生成物識別 |
| `src/clips.ts` | D1へのアクセス。読書状態の注釈レイヤーです |
| `src/digest.ts` | 週次ダイジェストの組み立て |
| `src/dismiss.ts` | 片付けの適用（D1の印と新着一覧の作り直し）と、そのボタン。ボタンとエージェントのツールの両方がここを通ります |
| `src/errors.ts` | `ClipError` と `ProcessingStage`。失敗をどの段階のものとして扱うか |
| `src/excerpt.ts` / `src/html.ts` | Worker側とNode側（バックフィル）の両方から呼びます。同じ入力から必ず同じ結果を出す必要があるため、**何もimportしない**制約があります |

## 開発

package managerはpnpmで、versionは `package.json` の `packageManager` で固定しています。CI側に別途versionを書かないでください。

| 目的 | コマンド |
|---|---|
| 依存の取得 | `sfw pnpm install` |
| テスト | `pnpm test` |
| 型検査 | `pnpm typecheck` |
| Worker設定の検証 | `pnpm dry-run`（Bot/CoreとMCP Edgeの両方） |
| ローカル起動 | `pnpm dev` |
| AI Gatewayの作成・更新 | `pnpm setup:aigw` |
| D1スキーマの適用 | `pnpm wrangler d1 execute reading-clipper-clips-db --local --file=./schema.sql`（本番は `--remote`） |
| D1のバックフィル | 手順は [`scripts/backfill-clips.ts`](scripts/backfill-clips.ts) の冒頭コメント。GitHubからD1を作り直します |

`pnpm dev` はローカルのsecretを `.dev.vars` から読みます（gitignore済み）。必要なキーは [`src/types.ts`](src/types.ts) の `Env` です。

D1のスキーマは `wrangler deploy` では適用されません。`schema.sql` を変更したら `--remote` と `--local` の両方へ手で流してください。`pnpm test` は `schema.sql` をそのまま読んでテーブルを作るため、事前準備は要りません。

`schema.sql` は `CREATE TABLE IF NOT EXISTS` の1文だけで構成します。テストが全体を1文として `prepare().run()` へ流すため、2文目を書くとテストが壊れます。既存のテーブルへ列を足すときは、`CREATE TABLE` の定義に列を書いたうえで、`ALTER TABLE` を `--command` で別途手で流してください。

`pnpm typecheck` は `wrangler types` で `worker-configuration.d.ts` を生成してから、スクリプト用（`tsconfig.json`）、Worker用（`src/tsconfig.json`）、テスト用（`test/tsconfig.json`）の3つを検査します。Workersのグローバル型とNodeの型は `fetch` などの定義が衝突するため、意図的に分けています。

`pnpm setup:aigw` には `CLOUDFLARE_ACCOUNT_ID` と、`AI Gateway Read` / `AI Gateway Write` 権限を持つ `CLOUDFLARE_API_TOKEN` が必要です。

依存を追加・更新するとき、共通ポリシーにより公開から7日未満のバージョンは除外されます。`ERR_PNPM_NO_MATURE_MATCHING_VERSION` はこの設定が正しく働いた結果です。設定を緩めて回避せず、7日以上前に公開されたバージョンを指定してください。

`wrangler.jsonc` の `compatibility_date` は、同梱されるworkerdがサポートする日付以下にしてください。超えると `wrangler dev` が起動しませんが、`deploy --dry-run` は通ってしまうためCIでは検出できません。変更したときは `pnpm dev` が起動することまで確認してください。

## 設計判断の記録

README.mdの方針を変更する判断をしたら、[`docs/adr/`](docs/adr/) にADRを追加してください。README.mdには結論と要約だけを書き、根拠・代替案・その方式で失うものはADR側に置きます。連番は既存の最大値+1です。

## インフラ管理

Cloudflareのリソースは `wrangler.jsonc` とWranglerを正本として管理します。OpenTofuは使用しません。判断の根拠と、この方式で失うもの（drift検出など）は [ADR 0001](docs/adr/0001-wrangler-over-opentofu.md) に記録しています。

AI GatewayだけはWranglerにコマンドが無いため、`scripts/setup-ai-gateway.ts` がCloudflare APIを直接呼びます。設定を変えるときは、ダッシュボードではなくこのスクリプトを編集してください。ゲートウェイのIDは `wrangler.jsonc` の `vars.AI_GATEWAY_ID` と一致させる必要があります。

## デプロイ

`wrangler deploy` を手で打ちません。Cloudflare Workers BuildsのGitHub連携が、`main` へのpushで自動デプロイします。Git連携の接続だけはコード化する手段が無く、ダッシュボードでの手動設定です（[ADR 0001](docs/adr/0001-wrangler-over-opentofu.md)）。

`main` へは直接pushできません。branch protectionにより、変更はPull Request経由で、`build` と `agent-docs-sync` のcheckを通してからmergeします。この保護はadminにも適用されます。承認は不要（required approvals: 0）ですが、PRを作る手順は省略できません。

`wrangler.jsonc` に書いてもデプロイでは作られないものがあります。

| 対象 | 作り方 |
|---|---|
| Queue本体、dead letter queue | `pnpm wrangler queues create` |
| D1データベース本体 | `pnpm wrangler d1 create` |
| D1のスキーマ | `schema.sql` を `d1 execute` で手動適用（上の表を参照） |
| Durable Objectのクラス | `wrangler.jsonc` の `migrations` により自動。コマンド不要 |
| Worker Secrets | `pnpm wrangler secret put <NAME>` |

## 共通ポリシーの例外

Cloudflare Workers Builds内の依存取得にはSocket Firewallを使いません。ビルド環境に `sfw` が用意されておらず、導入するには生のpackage managerを使うことになり、かえってポリシーに反するためです。

代わりにlockfileを必須とします。Workers Buildsにはinstall commandの入力欄が無いため、Build variable `SKIP_DEPENDENCY_INSTALL=1` で自動取得を止め、build commandを `pnpm install --frozen-lockfile` にしてlockfileの変更を拒否します。ローカルとGitHub ActionsのCIでは従来どおり `sfw` を経由します。

## 指示ファイルの同期

`AGENTS.md` と `CLAUDE.md` はシンボリックリンクではない別ファイルとして管理します。内容は完全に一致させ、片方を変更したらもう片方も同じ内容に更新してください。

同期は `.githooks/pre-commit` と GitHub Actions のCIで検証します。ローカルでは `git config core.hooksPath .githooks` を設定してください。
