# reading-clipper

## 初期構築中

このリポジトリは、あとで読むクリッピングサービスの初期構築中です。
作業を始める前に、必ず [`README.md`](README.md) を読み、そこに書かれた目的・初期バージョンの完了条件・制約を確認してください。README.md は初期構築時の設計書です。

初期構築が完了するまでは、開発速度を優先し、`main` へ直接コミットして push します。初期構築完了後は、branch protection、必須CI、Pull Requestを使う通常の運用へ切り替えます。この例外は初期構築期間だけに限定します。

## リポジトリの前提

- このリポジトリは公開リポジトリです。シークレット、トークン、秘密鍵、実環境固有のドメイン・アカウントID・プロジェクトIDをコミットしないでください。
- Cloudflare、GitHub、Slack、外部APIなどの実値は、環境変数またはGit管理外のローカル設定から渡します。
- README.mdに記載された共通ポリシーと設計上の未決事項を、実装前に確認してください。
- 依存関係の取得・更新は、Socket Firewall（`sfw`）経由で実行します。lockfileを管理し、CIではlockfileを変更しません。

## 開発

package managerはpnpmで、versionは `package.json` の `packageManager` で固定しています。CI側に別途versionを書かないでください。

| 目的 | コマンド |
|---|---|
| 依存の取得 | `sfw pnpm install` |
| 型検査 | `pnpm typecheck` |
| Worker設定の検証 | `pnpm wrangler deploy --dry-run` |
| ローカル起動 | `pnpm dev` |
| AI Gatewayの作成・更新 | `pnpm setup:aigw` |
| D1スキーマの適用 | `pnpm wrangler d1 execute reading-clipper-clips-db --local --file=./schema.sql`（本番は `--remote`） |

D1のスキーマは `wrangler deploy` では適用されません。`schema.sql` を変更したら `--remote` と `--local` の両方へ手で流してください。`pnpm test` は `schema.sql` をそのまま読んでテーブルを作るため、事前準備は要りません。

`pnpm typecheck` は `wrangler types` で `worker-configuration.d.ts` を生成してから、スクリプト用（`tsconfig.json`）とWorker用（`src/tsconfig.json`）の2つを検査します。Workersのグローバル型とNodeの型は `fetch` などの定義が衝突するため、意図的に分けています。

`pnpm setup:aigw` には `CLOUDFLARE_ACCOUNT_ID` と、`AI Gateway Read` / `AI Gateway Write` 権限を持つ `CLOUDFLARE_API_TOKEN` が必要です。

依存を追加・更新するとき、共通ポリシーにより公開から7日未満のバージョンは除外されます。`ERR_PNPM_NO_MATURE_MATCHING_VERSION` はこの設定が正しく働いた結果です。設定を緩めて回避せず、7日以上前に公開されたバージョンを指定してください。

`wrangler.jsonc` の `compatibility_date` は、同梱されるworkerdがサポートする日付以下にしてください。超えると `wrangler dev` が起動しませんが、`deploy --dry-run` は通ってしまうためCIでは検出できません。変更したときは `pnpm dev` が起動することまで確認してください。

## 設計判断の記録

README.mdの方針を変更する判断をしたら、[`docs/adr/`](docs/adr/) にADRを追加してください。README.mdには結論と要約だけを書き、根拠・代替案・その方式で失うものはADR側に置きます。連番は既存の最大値+1です。

## インフラ管理

Cloudflareのリソースは `wrangler.jsonc` とWranglerを正本として管理します。OpenTofuは使用しません。判断の根拠と、この方式で失うもの（drift検出など）は [ADR 0001](docs/adr/0001-wrangler-over-opentofu.md) に記録しています。

AI GatewayだけはWranglerにコマンドが無いため、`scripts/setup-ai-gateway.ts` がCloudflare APIを直接呼びます。設定を変えるときは、ダッシュボードではなくこのスクリプトを編集してください。ゲートウェイのIDは `wrangler.jsonc` の `vars.AI_GATEWAY_ID` と一致させる必要があります。

## 共通ポリシーの例外

Cloudflare Workers Builds内の依存取得にはSocket Firewallを使いません。ビルド環境に `sfw` が用意されておらず、導入するには生のpackage managerを使うことになり、かえってポリシーに反するためです。

代わりにlockfileを必須とし、install commandを `pnpm install --frozen-lockfile` にしてlockfileの変更を拒否します。ローカルとGitHub ActionsのCIでは従来どおり `sfw` を経由します。

## 指示ファイルの同期

`AGENTS.md` と `CLAUDE.md` はシンボリックリンクではない別ファイルとして管理します。内容は完全に一致させ、片方を変更したらもう片方も同じ内容に更新してください。

同期は `.githooks/pre-commit` と GitHub Actions のCIで検証します。ローカルでは `git config core.hooksPath .githooks` を設定してください。
