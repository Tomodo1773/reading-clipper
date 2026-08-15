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

受付と処理は論理的に分離するが、デプロイ単位は1つのWorkerとし、`fetch` ハンドラーと `queue` ハンドラーを同居させる。個人開発の規模では、secretsとデプロイ経路を1系統に保てる利点が、デプロイ単位を分ける利点を上回るため。

実装言語はTypeScriptとする。受付WorkerのHTTP処理にはHonoを使い、Queue処理はCloudflare Workersの `queue` handlerとして直接実装する。

## GitHubへの認証

クリップの保存先はprivate repositoryとし、認証にはprivateなGitHub Appを使用する。これは、公開するサービスのソースコードリポジトリとは別のリポジトリである。

- GitHub Appを保存先リポジトリだけにインストールする。
- Repository permissionは `Contents: Read and write` のみにする。
- 処理WorkerはGitHub AppとしてJWTを生成し、installation access tokenを取得してGitHub Contents APIを呼ぶ。
- installation access tokenは発行から1時間で失効する。
- GitHub Appのprivate keyはPKCS#8 PEM（`BEGIN PRIVATE KEY`）形式にしてCloudflare Workers Secretsへ保存する。

GitHubは、長期稼働する外部連携にはGitHub Appを推奨し、PATはAPIテストや短期間のスクリプトに適するとしている。そのためfine-grained PATは初期実装を簡単にするための代替候補にはなるが、本サービスの採用方式にはしない。

## インフラ管理とデプロイ

Cloudflareのリソースは `wrangler.jsonc` とWranglerを正本として管理する。OpenTofuは使用しない。

| 対象 | 管理方法 |
|---|---|
| Workerコード、Queue bindings、Queue consumer設定、observability | Git管理された `wrangler.jsonc` とWrangler |
| Queue本体とdead letter queue | `wrangler queues create` で作成する |
| AI Gateway | `scripts/setup-ai-gateway.ts`（Cloudflare APIを呼ぶ冪等スクリプト） |
| runtime secrets | ローカルからWranglerで登録し、Gitには保存しない |
| Gemini APIキー | AI GatewayのBYOK。Secrets Storeへ登録し、Workerには持たせない |
| WorkerのCI | GitHub Actions |
| Workerのデプロイ | Cloudflare Workers BuildsのGitHub連携 |
| Workers BuildsのGit連携 | ダッシュボードでの手動接続（コード化する手段が存在しない） |
| custom domainとWorkerの接続 | アプリとは別の非公開な場所で管理する |

### OpenTofuを使わない理由

初期検討ではCloudflare基盤をOpenTofuで管理する想定だったが、Cloudflare Provider v5を調査した結果、採用しない判断に切り替えた。Workerを宣言的に管理するとWorkers Buildsと二重管理になり、それを避けるとOpenTofuの管理対象がQueue、dead letter queue、AI Gatewayの3つだけになる。この3つのためにstate保存先と暗号化の運用を恒久的に抱えるのは規模に見合わない。

根拠、検討した代替案、この方式で失うもの（drift検出など）は [ADR 0001](docs/adr/0001-wrangler-over-opentofu.md) に記録している。

### 認証情報の受け渡し

AI Gatewayは認証必須（Authenticated Gateway）にする。Workerは `cf-aig-authorization` ヘッダーにトークンを付けて呼ぶ。

このトークンは `AI Gateway Run` 権限のCloudflare API tokenで、発行時に一度しか表示されない。取得を自動化するとスクリプトの出力やCIログに残るため、発行はダッシュボードで手動で行い、`wrangler secret put` でWorkerへ登録する。IaCの有無にかかわらず、この値を自動で受け渡すことはできない。

なおこのトークンはゲートウェイ単位に絞れない。`Run` 権限はアカウント内の全ゲートウェイに及ぶ。

Gemini APIキーはSecrets Store経由のBYOKにする。シークレット名は `{gateway_id}_{provider_slug}_{alias}` 形式が必須で、登録後はWorkerがGeminiのAPIキーを持つ必要がなくなる。

### デプロイ

CIはGitHub Actionsで実行し、依存取得にはSocket Firewallを使う。デプロイはCloudflare Workers BuildsのGitHub連携を使い、production branchへのpushで自動実行する。

production branchへの直接pushは禁止し、CIを必須checkにする。これにより、CIを通過してmergeされた変更だけがGit連携からデプロイされる。

Workers Builds内の依存取得にはSocket Firewallを使わない。これは共通ポリシーの明示的な例外とし、`AGENTS.md` と `CLAUDE.md` に理由を記録する。install commandは `pnpm install --frozen-lockfile` とし、lockfileの変更を拒否する。

アプリのリポジトリにはcustom domainやroute設定を置かない。ドメインの実値はGit管理外から渡す。

## 個人開発の共通ポリシー

専用リポジトリの作成時に、coworkの `REPOSITORY-POLICY.md` の最新版を適用する。この設計書には設定値を複製せず、共通ポリシーを正本とする。

サービスのソースコードリポジトリはpublic repositoryとして公開する。シークレットだけでなく、custom domain、プロジェクト名、アカウントIDなど自分の環境に固有の値もコミットしない。公開用の例や変数名を使い、実値はGit管理外から渡す。

今回のリポジトリでは、少なくとも次が対象になる。

- `AGENTS.md` と `CLAUDE.md` を別ファイルかつ同一内容で管理し、pre-commit hookとCIで同期を検証する。
- package managerはpnpmとし、versionを `package.json` の `packageManager` で固定する。CIはその指定を参照し、別途versionを書かない。ローカルとCIの依存取得・更新はSocket Firewall経由にする。
- 公開直後version除外、依存build script制御、lockfile信頼設定を `pnpm-workspace.yaml` に適用する。
- 使用するpackage ecosystemとGitHub ActionsをDependabotの対象にし、更新間隔とcooldownを共通ポリシーに合わせる。
- GitHub Actionsは完全長commit SHAに固定し、`GITHUB_TOKEN` を必要最小権限にする。

GitHub ActionsのCIではSocket Firewallを準備した後にlockfile固定で依存を取得する。CDはこのCIとは別にCloudflare Workers Buildsが行う。

## 実装手順

完了した項目には末尾に **完了** と記録する。

1. プロジェクトの足場、`wrangler.jsonc`、AI Gatewayセットアップスクリプトを書く。**完了**（[ADR 0001](docs/adr/0001-wrangler-over-opentofu.md)）
2. TypeScript、Hono、Queue consumerのアプリコードを書く。**完了**
3. 保存先private repository用のGitHub Appを作成してインストールする。**完了**
4. X APIキーを用意する。**完了**（Bearer Token取得済み。X APIクレジット購入と支出上限設定は未完了）
5. Firecrawl APIキーを取得する。**完了**
6. Gemini APIキーを用意する。**完了**
7. Slack App/Botを作成し、URLを受け付ける設定を用意する。
8. Cloudflareのリソースを用意する。**完了**
   1. `pnpm wrangler queues create reading-clipper-clips` と `pnpm wrangler queues create reading-clipper-clips-dlq`。**完了**
   2. `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を設定して `pnpm setup:aigw` を実行し、AI Gatewayを作成する。**完了**
   3. AI Gatewayの認証トークンをダッシュボードで発行する。表示は一度きり。**完了**
   4. Gemini APIキーをSecrets Storeへ登録する（BYOK）。**完了**
   5. runtime secretsを `pnpm wrangler secret put <NAME>` で登録する。対象は `src/types.ts` の `Env` を参照する。**完了**

X APIは認証情報を取得しただけでは実際のAPI呼び出しまで完了しない。初回のX取得テスト前に、Developer Consoleでクレジットを購入し、支出上限を設定する。[X API pricing](https://docs.x.com/x-api/getting-started/pricing)
9. ソースコードをpublic GitHub repositoryへpushする。**完了**
10. CloudflareダッシュボードでWorkers BuildsのGit連携を手動で接続する。
11. CI通過後、production branchへのmergeでWorkers Buildsがデプロイする。

## URL別の取得方針

| 対象 | 初期方針 | 現時点の扱い |
|---|---|---|
| Qiitaの記事 | 記事URL末尾に `.md` を付けて取得 | Qiita公式ブログで提供方法を確認済み |
| Xの投稿・記事 | X APIを利用 | `article`、`note_tweet`、通常本文の順で取得する |
| その他のWebページ | Firecrawlを利用 | Scrape APIがMarkdownを返せることを確認済み |

## アプリの動作

- Slack AppとのDM（メッセージタブ）へURLを送る。結果は元メッセージのスレッドへ返す。
- 1通に複数URLがある場合は先頭だけを処理し、残りの件数を結果に表示する。
- 保存先は `clips/{host}/{pathSlug}-{URL hash}.md` とする。同じURLを新しく送ると再取得して同じファイルを更新し、Slack自身による同一イベントの再送は保存済み結果を再利用する。
- 本文取得に失敗した場合は保存も要約もしない。要約だけが失敗した場合は、その事実を記録して本文だけ保存する。
- 一時的な失敗は指数バックオフ付きで3回再試行する。最終失敗をSlackへ通知した後、メッセージをdead letter queueへ送り、4日以内に原因を直してURLを再送する。

## Slackへ返す要約

要約は2〜4文とし、見出しやセクション分けをせず、Slackのチャットに収まる自然な文章にする。

初期版ではGemini 3.7 Flashを使う。モデル名は `AI_MODEL` bindingで差し替え可能にする。Cloudflare AI GatewayのOpenAI互換エンドポイントを使い、将来OpenAIへ移行できるようプロバイダ固有SDKに依存しない。

GeminiはCloudflare AI Gateway経由で呼び出し、AI Gatewayでプロンプトと応答本文を含むログを保存して、要約の入力と出力を追跡できるようにする。OpenTelemetryの送信先は将来必要になった時点で決める。

少なくとも次を伝える。

- 何について書かれたものか
- 主な結論
- 結論に至る主要な内容
- 取得が不完全な場合は、その事実
- GitHubへの保存成否

Geminiには、テーマと結論を1文、主要な内容を1文で返させる。取得の不完全性とGitHub保存結果はアプリ側で追加し、Slackへの返信全体を2〜4文に保つ。実際の記事を使った確認はAPIキーを用意した後に行い、必要なら `AI_MODEL` またはプロンプトを調整する。

## 初期バージョンに含めないもの

- 未読・既読状態の管理
- 未読記事の定期通知と推薦
- 保存済み記事の検索・質問応答
- 興味傾向の分析

これらは将来候補として残すが、初期バージョンの保存処理とは分けて設計する。

## 未読・既読管理は別途設計する

未読・既読管理には、保存時だけでなく、数週間または数か月後に記事を再発見して状態を変更できる恒久的な操作導線が必要になる。

状態の種類、状態の正本、記事の探し方、変更・取り消し・一括操作、Slack以外の操作面の要否を含め、利用場面から別途設計する。それまでは読書状態のデータ設計を行わない。

## 取得内容の扱い

XはAPIから取得できる公開Postだけを対象とし、protected contentや位置情報は保存しない。著者と元URLをMarkdownに残し、保存先private repositoryの外へ再配布しない。Qiitaと一般Webも、利用者が指定したURLを個人利用のprivate repositoryへ保存する範囲に限定する。

## 初期バージョンの完了条件

- Slackへ送ったQiita、X、一般WebのURLが、それぞれ定めた取得方法へ振り分けられる。
- 取得した内容がMarkdownとして指定のGitHubリポジトリへ保存される。
- Slackへ、主な結論と内容を含む2〜4文の要約が返る。
- Slackの返信から、保存に成功したか失敗したかを判別できる。
- 取得できなかった内容を、取得できたものとして保存・要約しない。

## 設計判断の記録

この設計書の方針を変更した判断は、[`docs/adr/`](docs/adr/) にADRとして残す。README.mdには結論と要約だけを書き、根拠・代替案・失うものはADR側に置く。

- [ADR 0001: Cloudflareのインフラ管理をOpenTofuではなくWranglerに寄せる](docs/adr/0001-wrangler-over-opentofu.md)

## 確認済みの外部仕様

- [Qiita公式ブログ：投稿URL末尾の `.md`](https://blog.qiita.com/77994282605-2/)
- [Firecrawl Scrape](https://docs.firecrawl.dev/features/scrape)
- [X API Overview](https://docs.x.com/x-api/overview)
- [Slack Events API](https://docs.slack.dev/apis/events-api/) — イベント受信側は3秒以内にHTTP応答する必要があるため、本文取得や要約を同じリクエストの完了まで待たせない
- [Cloudflare Queues](https://developers.cloudflare.com/queues/) — HTTP応答と本文取得・要約処理を分離する
- [Cloudflare Queuesの設定](https://developers.cloudflare.com/queues/configuration/configure-queues/) — `dead_letter_queue`、`max_batch_size`、`max_retries` をWrangler設定ファイルに書ける
- [Wrangler queuesコマンド](https://developers.cloudflare.com/workers/wrangler/commands/queues/) — Queue本体の作成・更新
- [Cloudflare Workers BuildsのGit連携](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/) — 接続はダッシュボードでの手動操作のみ
- [Cloudflare Provider issue #6924](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6924) — Workers BuildsのGit連携はTerraformで管理できない
- [Cloudflare Workers Buildsの設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) — Worker bindingsのsource of truth
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [Cloudflare AI Gateway Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) — プロンプトと応答本文の保存は既定で有効
- [Cloudflare AI Gateway Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) — トークンは `AI Gateway Run` 権限のAPI tokenで、表示は一度きり
- [Cloudflare AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) — シークレット名は `{gateway_id}_{provider_slug}_{alias}` 形式
- [Cloudflare AI Gateway OpenTelemetry](https://developers.cloudflare.com/ai-gateway/observability/otel-integration/)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — GitHub AppのJWT署名に必要なRSA署名を利用できる
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [GitHub公式：GitHub Appを選ぶ場合](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [GitHub Appのinstallation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) — 有効期限は1時間
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents) — リポジトリ内のファイルを作成・更新できる
