# あとで読むクリッピングサービス（仮）

## 目的

技術ブログ、Xの投稿・記事、公式ドキュメントなどの「あとで読みたい」が、複数のブックマーク機能に分散し、保存したまま読まれずに残っている。

このサービスは、URLの受付をSlackに集約し、取得した内容をMarkdownとして自分のGitHubリポジトリへ保存する。保存直後には、読むかどうかを判断できる要約をSlackへ返す。

GitHubへ蓄積したMarkdownは、将来の検索、AIによる質問応答、興味傾向の分析にも利用できるようにしたい。

## 初期バージョン

初期バージョンは、次の一連の処理が完了するところまでとする。

1. スマートフォンなどから、対象URLをSlackの専用Botへ共有する。
2. URLに適した方法で内容を取得する。
3. 取得内容をMarkdownへ整える。
4. Markdownを指定したGitHubリポジトリへ保存する。
5. AIで生成した要約と保存結果をSlackへ返信する。

処理の概略：

```text
Slack
  ↓
受付Worker ──→ Cloudflare Queue ──→ 処理Worker
  │                                  ├→ URL別の取得処理
  └→ 3秒以内にHTTP応答               ├→ Markdown化・GitHub保存
                                     └→ AI要約・Slack返信
```

受付WorkerはSlackの署名を検証し、処理内容をCloudflare Queueへ登録して3秒以内にHTTP応答する。本文取得、AI要約、GitHub保存はQueueを受け取る処理Workerが行う。

受付と処理は論理的に分離する。別々のWorkerとしてデプロイするか、1つのWorkerにHTTP用とQueue用のハンドラーを持たせるかは、実装時に決める。

実装言語はTypeScriptとする。受付WorkerのHTTP処理にはHonoを使い、Queue処理はCloudflare Workersの `queue` handlerとして直接実装する。

## GitHubへの認証

クリップの保存先はprivate repositoryとし、認証にはprivateなGitHub Appを使用する。これは、公開するサービスのソースコードリポジトリとは別のリポジトリである。

- GitHub Appを保存先リポジトリだけにインストールする。
- Repository permissionは `Contents: Read and write` のみにする。
- 処理WorkerはGitHub AppとしてJWTを生成し、installation access tokenを取得してGitHub Contents APIを呼ぶ。
- installation access tokenは発行から1時間で失効する。
- GitHub Appのprivate keyはCloudflare Workers Secretsへ保存する。

GitHubは、長期稼働する外部連携にはGitHub Appを推奨し、PATはAPIテストや短期間のスクリプトに適するとしている。そのためfine-grained PATは初期実装を簡単にするための代替候補にはなるが、本サービスの採用方式にはしない。

## インフラ管理とデプロイ

Cloudflareのインフラ管理にはOpenTofuとCloudflare Providerを使用する。OpenTofuの実行は自動化せず、ローカルから `tofu plan` と `tofu apply` を実行する。

管理対象を次のように分ける。

| 対象 | 管理方法 |
|---|---|
| Cloudflare Queueなど、Workerコードから独立した基盤 | OpenTofu |
| Workerコード、Queue bindings、Queue consumer設定 | Git管理された `wrangler.jsonc` とWrangler |
| WorkerのCI | GitHub Actions |
| Workerのデプロイ | Cloudflare Workers BuildsのGitHub連携 |
| runtime secrets | ローカルからWranglerで登録し、GitやOpenTofu stateには保存しない |
| custom domainとWorkerの接続 | アプリとは別のprivateなOpenTofu stack |

CIはGitHub Actionsで実行し、依存取得にはSocket Firewallを使う。デプロイはCloudflare Workers BuildsのGitHub連携を使い、production branchへのpushで自動実行する。

production branchへの直接pushは禁止し、CIを必須checkにする。これにより、CIを通過してmergeされた変更だけがGit連携からデプロイされる。

Workers Builds内の依存取得にはSocket Firewallを使わない。これは共通ポリシーの明示的な例外とし、専用リポジトリの `AGENTS.md` と `CLAUDE.md` に理由を記録する。lockfileを必須とし、使用するpackage managerでlockfileの変更を拒否するinstall commandを設定する。

OpenTofuとWranglerで同じリソースを重複管理しない。OpenTofuのstateをどこに保存・バックアップするかは、実装前に決める。

アプリのリポジトリにはcustom domainやroute設定を置かない。別のOpenTofu stackではドメインを変数として受け取り、実値はローカルの環境変数またはGit管理外の `.tfvars` から渡す。ドメイン値はOpenTofu stateに記録されるため、stateはGitへcommitせず、非公開かつ暗号化された場所に保存する。

## 個人開発の共通ポリシー

専用リポジトリの作成時に、coworkの `REPOSITORY-POLICY.md` の最新版を適用する。この設計書には設定値を複製せず、共通ポリシーを正本とする。

サービスのソースコードリポジトリはpublic repositoryとして公開する。シークレットだけでなく、custom domain、プロジェクト名、アカウントIDなど自分の環境に固有の値もコミットしない。公開用の例や変数名を使い、実値はGit管理外から渡す。

今回のリポジトリでは、少なくとも次が対象になる。

- `AGENTS.md` と `CLAUDE.md` を別ファイルかつ同一内容で管理し、pre-commit hookとCIで同期を検証する。
- 使用するpackage managerのversionをmanifestで固定し、lockfileを管理する。ローカルとCIの依存取得・更新はSocket Firewall経由にする。
- pnpmを選ぶ場合は、公開直後version除外、依存build script制御、lockfile信頼設定を共通ポリシーどおり適用する。
- 使用するpackage ecosystemとGitHub ActionsをDependabotの対象にし、更新間隔とcooldownを共通ポリシーに合わせる。
- GitHub Actionsは完全長commit SHAに固定し、`GITHUB_TOKEN` を必要最小権限にする。

GitHub ActionsのCIではSocket Firewallを準備した後にlockfile固定で依存を取得する。CDはこのCIとは別にCloudflare Workers Buildsが行う。

## 実装手順

1. OpenTofuで管理する基盤のIACを書く。
2. TypeScript、Hono、Queue consumerのアプリコードを書く。
3. 保存先private repository用のGitHub Appを作成してインストールする。
4. X APIキーを用意する。
5. Firecrawl APIキーを取得する。
6. Gemini APIキーを用意し、AI GatewayのBYOKへ登録する。
7. Slack App/Botを作成し、URLを受け付ける設定を用意する。
8. CloudflareやGitHub Appなどの認証情報をローカル環境変数に設定し、IACをprovisionする。runtime secretsはWranglerで登録する。
9. ソースコードをpublic GitHub repositoryへpushし、CI通過後にCloudflare Workers BuildsのCDでデプロイする。

## URL別の取得方針

| 対象 | 初期方針 | 現時点の扱い |
|---|---|---|
| Qiitaの記事 | 記事URL末尾に `.md` を付けて取得 | Qiita公式ブログで提供方法を確認済み |
| Xの投稿・記事 | X APIを利用 | 通常の投稿は取得対象とし、X Articles本文の取得可否だけ実装前に確認する |
| その他のWebページ | Firecrawlを利用 | Scrape APIがMarkdownを返せることを確認済み |

## Slackへ返す要約

要約は2〜4文とし、見出しやセクション分けをせず、Slackのチャットに収まる自然な文章にする。

初期版ではGeminiを使う。Cloudflare AI GatewayのOpenAI互換エンドポイントを使い、将来OpenAIへ移行できるようプロバイダ固有SDKに依存しない。

GeminiはCloudflare AI Gateway経由で呼び出し、AI Gatewayでプロンプトと応答本文を含むログを保存して、要約の入力と出力を追跡できるようにする。OpenTelemetryの送信先は将来必要になった時点で決める。

少なくとも次を伝える。

- 何について書かれたものか
- 主な結論
- 結論に至る主要な内容
- 取得が不完全な場合は、その事実
- GitHubへの保存成否

Geminiのモデルとプロンプトは、実際の記事を使った出力比較を行ってから決める。

## 初期バージョンに含めないもの

- 未読・既読状態の管理
- 未読記事の定期通知と推薦
- 保存済み記事の検索・質問応答
- 興味傾向の分析

これらは将来候補として残すが、初期バージョンの保存処理とは分けて設計する。

## 未読・既読管理は別途設計する

未読・既読管理には、保存時だけでなく、数週間または数か月後に記事を再発見して状態を変更できる恒久的な操作導線が必要になる。

状態の種類、状態の正本、記事の探し方、変更・取り消し・一括操作、Slack以外の操作面の要否を含め、利用場面から別途設計する。それまでは読書状態のデータ設計を行わない。

## 実装前に決めること

- SlackでURLを送る具体的な方法と送信先
- X Articles本文を公式APIで取得できるか
- 各取得元の利用条件上、どこまで本文を保存できるか
- 同じURLが再度送られた場合の扱い
- 取得、要約、GitHub保存のどこかが失敗した場合の扱い
- 2〜4文要約の品質基準と評価方法
- Queue処理が失敗した場合の再試行と通知
- OpenTofu stateの保存先とバックアップ方法

これらは実装時に都合のよい方式を先に置かず、利用例、制約、費用を確認してから決める。

## 初期バージョンの完了条件

- Slackへ送ったQiita、X、一般WebのURLが、それぞれ定めた取得方法へ振り分けられる。
- 取得した内容がMarkdownとして指定のGitHubリポジトリへ保存される。
- Slackへ、主な結論と内容を含む2〜4文の要約が返る。
- Slackの返信から、保存に成功したか失敗したかを判別できる。
- 取得できなかった内容を、取得できたものとして保存・要約しない。

## 確認済みの外部仕様

- [Qiita公式ブログ：投稿URL末尾の `.md`](https://blog.qiita.com/77994282605-2/)
- [Firecrawl Scrape](https://docs.firecrawl.dev/features/scrape)
- [X API Overview](https://docs.x.com/x-api/overview)
- [Slack Events API](https://docs.slack.dev/apis/events-api/) — イベント受信側は3秒以内にHTTP応答する必要があるため、本文取得や要約を同じリクエストの完了まで待たせない
- [Cloudflare Queues](https://developers.cloudflare.com/queues/) — HTTP応答と本文取得・要約処理を分離する
- [Cloudflare QueueのTerraform resource](https://developers.cloudflare.com/api/terraform/resources/queues/)
- [Cloudflare Worker custom domainのTerraform resource](https://developers.cloudflare.com/api/terraform/resources/workers/)
- [OpenTofu FAQ](https://opentofu.org/faq/) — 既存のTerraform Providerを利用できる
- [OpenTofu input variables](https://opentofu.org/docs/language/values/variables/) — 環境変数や `.tfvars` から値を渡せる
- [OpenTofu state encryption](https://opentofu.org/docs/language/state/encryption/)
- [Cloudflare Workers BuildsのGit連携](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/)
- [Cloudflare Workers Buildsの設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) — Worker bindingsのsource of truth
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare AI Gateway Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Cloudflare AI Gateway OpenTelemetry](https://developers.cloudflare.com/ai-gateway/observability/otel-integration/)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — GitHub AppのJWT署名に必要なRSA署名を利用できる
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [GitHub公式：GitHub Appを選ぶ場合](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [GitHub Appのinstallation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) — 有効期限は1時間
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents) — リポジトリ内のファイルを作成・更新できる
