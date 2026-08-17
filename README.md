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
  ├→ 受け取った印に 👀                ├→ ThreadAgent (Durable Object) から会話履歴を読む
  └→ 3秒以内にHTTP応答                ├→ AIとのやり取り（google_searchはGemini側で実行）
                                      │   └→ save_clipツール
                                      │       （URL別の取得 → Markdown化 → GitHub保存）
                                      ├→ ThreadAgent へ1ターンぶんを追記
                                      └→ Slack返信
```

受付WorkerはSlackの署名、ワークスペースID、ユーザーIDを検証し、許可されたユーザーのメッセージだけをCloudflare Queueへ登録して3秒以内にHTTP応答する。

届いたメッセージはURLの有無で分岐させず、すべてAIへ渡す。保存はAIが呼ぶ `save_clip` ツールとして実装し、取得・Markdown化・GitHub保存はそのツールの中で行う（[ADR 0006](docs/adr/0006-agent-with-save-tool.md)）。

会話の状態はSlackのスレッド単位のDurable Object `ThreadAgent` が持つ。AIへ渡す形のまま、ツール呼び出しとその結果を含めて追記していく。記事本文はツール結果の中に残るため、同じスレッドで掘り下げて質問されても取得し直さない（[ADR 0007](docs/adr/0007-thread-history-in-durable-object.md)）。

AIとのやり取りは処理Worker側で行い、`ThreadAgent` は会話の読み書きだけを持つ。同じスレッドへ立て続けに届いた2通が並走しないよう、Queue consumerは `max_concurrency: 1` で消費する（[ADR 0008](docs/adr/0008-ai-sdk-and-model-calls-outside-the-durable-object.md)）。

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
| Workerコード、Queue bindings、Queue consumer設定、Durable Objects bindings、observability | Git管理された `wrangler.jsonc` とWrangler |
| Durable Objectのクラスとストレージ | `wrangler.jsonc` の `migrations`（`new_sqlite_classes`）。作成コマンドは不要 |
| Queue本体とdead letter queue | `wrangler queues create` で作成する |
| D1データベース本体とスキーマ | `wrangler d1 create` で作成し、[`schema.sql`](schema.sql) を `wrangler d1 execute` で適用する。`wrangler deploy` はmigrationを適用しないため、どちらもローカルからの手動操作にする |
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

Workers Builds内の依存取得にはSocket Firewallを使わない。これは共通ポリシーの明示的な例外とし、`AGENTS.md` と `CLAUDE.md` に理由を記録する。Workers Buildsにはinstall commandの入力欄がないため、Build variable `SKIP_DEPENDENCY_INSTALL=1` で自動取得を無効化し、Build commandを `pnpm install --frozen-lockfile` にしてlockfileの変更を拒否する。

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
6. Gemini APIキーを用意する。**完了**／Google検索グラウンディングは無料枠では使えないため、Google Cloudプロジェクトを紐づけてGemini APIのbillingを有効にする。**未完了**
7. Slack App/Botを作成し、URLを受け付ける設定を用意する。**完了**
   1. App HomeのMessages Tabを有効化し、ユーザーからのメッセージ送信を許可する。**完了**
   2. Bot Token Scopesに `chat:write` と `im:history` を追加する。**完了**／`reactions:write` の追加は**未完了**。追加後はSlack Appの再インストールが必要で、それまで 👀 は付かない（本処理は続く）。
   3. Socket Modeを無効にする。**完了**
   4. Event SubscriptionsのRequest URLを `https://<Workerの公開ホスト>/slack/events` にし、Bot Event `message.im` を購読する。**完了**
   5. Signing SecretとBot User OAuth Tokenを、それぞれ `SLACK_SIGNING_SECRET` と `SLACK_BOT_TOKEN` としてWorkerへ登録する。**完了**

Socket Modeが有効な間、SlackはイベントをWebSocketでのみ配信し、Request URLへHTTP POSTを送らない。URL検証だけは行われるためRequest URLは `Verified` と表示され、購読設定も正しく見えたまま、DMを送ってもWorkerには何も届かない。Request URLの入力欄もロックされる。設定画面の目視では原因が分からないため、`settings.socket_mode_enabled` をApp Manifestで確認する。
8. Cloudflareのリソースを用意する。**完了**
   1. `pnpm wrangler queues create reading-clipper-clips` と `pnpm wrangler queues create reading-clipper-clips-dlq`。**完了**
   2. `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を設定して `pnpm setup:aigw` を実行し、AI Gatewayを作成する。**完了**
   3. AI Gatewayの認証トークンをダッシュボードで発行する。表示は一度きり。**完了**
   4. Gemini APIキーをSecrets Storeへ登録する（BYOK）。**完了**
   5. runtime secretsを `pnpm wrangler secret put <NAME>` で登録する。対象は `src/types.ts` の `Env` を参照する。**完了**

X APIは認証情報を取得しただけでは実際のAPI呼び出しまで完了しない。初回のX取得テスト前に、Developer Consoleでクレジットを購入し、支出上限を設定する。[X API pricing](https://docs.x.com/x-api/getting-started/pricing)

受信Workerは、Slack署名だけでなく `team_id` と `event.user` もallowlistで検証する。`SLACK_ALLOWED_TEAM_ID` に許可するワークスペースのIDを、`SLACK_ALLOWED_USER_ID` に許可するユーザーIDを1件だけ登録する。許可されていないメッセージはSlackへ返信せず、Queueにも登録しない。設定値が空欄の場合も全拒否する。

```text
pnpm wrangler secret put SLACK_ALLOWED_TEAM_ID
pnpm wrangler secret put SLACK_ALLOWED_USER_ID
```

初期版は未配布の単一ワークスペース用Slack Appを前提とする。Slack Appの配布設定を変更して複数ワークスペースで使う場合は、ワークスペースごとのOAuth認証とBot token管理を別途設計する。
9. ソースコードをpublic GitHub repositoryへpushする。**完了**
10. CloudflareダッシュボードでWorkers BuildsのGit連携を手動で接続する。**完了**
    1. GitHub App `Cloudflare Workers and Pages` をインストールし、`Tomodo1773/reading-clipper` だけにRepository accessを許可する。**完了**
    2. Production branchを `main`、Root directoryを `/` にする。**完了**
    3. Build variableを `SKIP_DEPENDENCY_INSTALL=1`、Build commandを `pnpm install --frozen-lockfile`、Deploy commandを `pnpm deploy` にする。**完了**
    4. 非production branchの自動Buildは無効にし、非production branch deploy commandは既定の `npx wrangler versions upload` のままにする。**完了**
11. CI通過後、production branchへのmergeでWorkers Buildsがデプロイする。**完了**
12. 未読の週次通知を有効にする（[ADR 0010](docs/adr/0010-weekly-digest-and-dismiss-bit.md)）。
    1. `pnpm wrangler d1 create reading-clipper-clips-db` を実行し、出力された `database_id` を `wrangler.jsonc` へ書く。**完了**
    2. `pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=./schema.sql` を実行する。`wrangler dev` 用に `--local` でも同じものを適用する。**完了**
    3. Slack AppのBot Token Scopesへ `im:write` を追加し、Slack Appを再インストールする。cronハンドラは `conversations.open` でDMのチャンネルIDを引くため、これが無いとダイジェストを投稿できない。**完了**
    4. Slack AppのInteractivity & Shortcutsを有効化し、Request URLを `https://<Workerの公開ホスト>/slack/interactivity` にする。**完了**
    5. 既存クリップをD1へ流し込む。**完了**
13. ダイジェストの表示を抜粋とサムネイル付きにする（[ADR 0011](docs/adr/0011-digest-rows-with-excerpt-and-thumbnail.md)）。
    1. 既存のD1へ列を3つ足す。`schema.sql` は `CREATE TABLE IF NOT EXISTS` なので既存テーブルには効かない。`--remote` と `--local` の両方へ流す。

    ```text
    pnpm wrangler d1 execute reading-clipper-clips-db --remote \
      --command "ALTER TABLE clips ADD COLUMN title TEXT;"
    pnpm wrangler d1 execute reading-clipper-clips-db --remote \
      --command "ALTER TABLE clips ADD COLUMN excerpt TEXT;"
    pnpm wrangler d1 execute reading-clipper-clips-db --remote \
      --command "ALTER TABLE clips ADD COLUMN image_url TEXT;"
    ```

    2. バックフィルを流し直し、`url` / `title` / `excerpt` / `image_url` と本物の `clipped_at` を既存の行へ埋める。

    ```text
    git clone --depth 1 https://github.com/<owner>/<repo>.git /tmp/clips
    node --experimental-strip-types scripts/backfill-clips.ts /tmp/clips > backfill.sql
    pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=backfill.sql
    ```

バックフィルはcloneしたリポジトリのフロントマターを読む。GitHubへのリクエストはcloneの1回だけで、`image_url` の無い記事についてのみ `og:image` を取りに行く。既にある行の `dismissed_at` と `last_shown_at` には触れない。D1を失ったときの復旧もこれと同じ操作で行う。

cronの動作は日曜まで待たずに確認できる。`pnpm wrangler dev` で起動し、`curl "http://localhost:8787/cdn-cgi/handler/scheduled"` を叩くと `scheduled` ハンドラが走る。

Cloudflareのcronは曜日フィールドが `1-7` / `MON-SUN` で、標準的なcronの `0`（日曜）を受け付けない。`deploy --dry-run` では検出できず、`wrangler deploy` がAPIに弾かれて初めて分かる。しかもコードのアップロードは成功した後にトリガー登録だけが失敗する**部分適用**になるため、「デプロイされたのにcronが動かない」状態になる。デプロイの成否はコマンドの終了コードで確認する。

Slackイベント受信、Queue処理、本文取得、GitHub保存、AI要約、Slackへのスレッド返信までを通すE2Eを確認済み。Qiita、Zenn、X、一般Webの4系統それぞれでの取得確認と要約内容の確認は未完了。

## URL別の取得方針

| 対象 | 初期方針 | 現時点の扱い |
|---|---|---|
| Qiitaの記事 | 記事URL末尾に `.md` を付けて取得 | Qiita公式ブログで提供方法を確認済み |
| Zennの記事 | （当初はその他のWebページに含めていた） | 非公式APIの `body_html` を自前でMarkdownへ変換する（[ADR 0003](docs/adr/0003-zenn-unofficial-api.md)） |
| Xの投稿・記事 | X APIを利用 | `article`、`note_tweet`、通常本文の順で取得する |
| その他のWebページ | Firecrawlを利用 | Scrape APIがMarkdownを返せることを確認済み |

Zennには記事URL末尾に `.md` を付ける手段も、Markdown原稿を返すAPIも無い。対象は記事だけとし、本（`/books/`）とスクラップ（`/scraps/`）は汎用Web扱いのままにする。

## アプリの動作

- Slack AppとのDM（メッセージタブ）へメッセージを送る。返信は元メッセージのスレッドへ返す。
- メッセージを送ると、処理を始める前にそのメッセージへ 👀 が付く。受け取った印なので、返信が来ても外れない。
- URLだけを送れば保存して要約が返る。文を添えれば会話になる。URLが含まれていても、感想を聞いているのか保存してほしいのかはAIが判断する。
- スレッドに続けて質問すると、そのスレッドで保存した記事の内容を踏まえて答える。記事は取得し直さない。
- スレッド内の返信は親メッセージに紐づく。別のメッセージから始めれば別の会話になる。
- 保存した記事と関係のない、最新の事実を聞かれたときはWebを検索して答える。保存済み記事についての質問では検索せず、手元の本文を使う（[ADR 0009](docs/adr/0009-google-search-grounding.md)）。
- 保存先は `clips/{host}/{記事タイトル}.md` とする。ファイル名は記事タイトルだけから作り、URLハッシュは付けない。日本語はそのまま残し、Windowsで使えない文字・予約デバイス名・255バイトの上限だけを潰す。同一ホスト内でファイル名が衝突した場合は上書きする（[ADR 0005](docs/adr/0005-title-based-file-name-and-plain-body.md)）。
- 保存するMarkdownは、フロントマターの直下に取得した本文をそのまま置く。見出しやセクションを足さず、AI要約も保存しない。要約はSlackへ返すためだけに使う。
- 同じURLを新しく送ると再取得して同じファイルを更新する。ただし汎用Web経路はFirecrawlの既定のキャッシュに任せるため、最大2日間は前回取得した内容が返りうる。速度と成功率を優先した意図的な挙動で、常に最新へ更新することは保証しない。
- 本文取得に失敗した場合は保存しない。失敗したという事実をツールの結果としてAIへ返し、AIがその旨を返信する。
- Slack自身による同一イベントの再送と、Queueの再試行は、`ThreadAgent` が処理済み `event_id` を記録して二重に会話を進めないようにする。Slackへの投稿だけが失敗した再試行は、保存済みの返信を送り直す。
- モデルの呼び出しとSlackへの投稿が一時的に失敗した場合は、Queueが指数バックオフ付きで3回再試行する。最終失敗をSlackへ通知した後、メッセージをdead letter queueへ送り、4日以内に原因を直して送り直す。
- モデルの呼び出しは、Queueの再試行に回る前にAI SDKが数秒間隔で2回再試行する。モデル側の瞬間的な混雑を、Queueの再試行枠を使わずに吸収するため（[ADR 0008](docs/adr/0008-ai-sdk-and-model-calls-outside-the-durable-object.md)）。
- 記事の取得やGitHubへの保存が失敗した場合は、再試行せずその事実をツールの結果としてAIへ返す。取り直すかどうかはユーザーが決める（[ADR 0008](docs/adr/0008-ai-sdk-and-model-calls-outside-the-durable-object.md)）。

## Slackへ返す文章

保存直後の要約は1〜2文（60〜120字程度）の簡潔な一言とし、見出しやセクション分けをせず、Slackのチャットに収まる自然な文章にする。掘り下げの質問に答えるときは長さの縛りを外す。口調は面倒見のいい年上のお姉さんのタメ口に統一する（[ADR 0004](docs/adr/0004-concise-summary.md)）。

要約・保存結果・掘り下げの回答は、すべてAIが1つの文章として書く。アプリ側で固定文を足したりリンクを組み立てたりはしない。取得の不完全性（`fetch_complete`）と保存の成否（`saved`）はツールの結果に事実として入れ、それをどう伝えるかはAIに任せる（[ADR 0006](docs/adr/0006-agent-with-save-tool.md)）。

初期版ではGemini 3.7 Flashを使う。モデル名は `AI_MODEL` bindingで差し替え可能にする。モデルの呼び出しとツールの往復にはVercel AI SDK（`ai` と `@ai-sdk/google`）を使い、応答のパースやツールループを自作しない。GeminiはネイティブAPI形式で呼ぶ。プロバイダを移るときは `@ai-sdk/*` のプロバイダを差し替える（[ADR 0008](docs/adr/0008-ai-sdk-and-model-calls-outside-the-durable-object.md)）。

GeminiはCloudflare AI GatewayのGoogle AI Studioパススルー経由で呼び出し、AI Gatewayでプロンプトと応答本文を含むログを保存して、入力と出力を追跡できるようにする。OpenTelemetryの送信先は将来必要になった時点で決める。

保存直後の返信では、少なくとも次を伝える。

- 何について書かれたものか
- 主な結論
- 取得が不完全な場合は、その事実
- GitHubへの保存成否

会話の中で事実の裏取りが要るときは、GeminiのGoogle検索グラウンディング（provider-executedな `google_search`）で調べてから答える。検索するかどうかはAIが判断し、アプリ側では判定しない。出典はアプリが組み立てず、AIがサイト名や記事名として文中に添える。グラウンディングが返すURLは期限付きのリダイレクトURLなので、そのまま貼らせない。この形はGemini API追加利用規約が求めるSearch Suggestionsの表示を満たしておらず、個人利用の範囲に限って未準拠を受け入れる（[ADR 0009](docs/adr/0009-google-search-grounding.md)）。

グラウンディングはGemini 3.x系の無料枠では使えないため、Gemini APIのbilling有効化が前提になる。無料枠のまま呼ぶと429で失敗し、待っても回復しない（[ADR 0009](docs/adr/0009-google-search-grounding.md)）。

## 初期バージョンに含めないもの

- 未読記事の推薦（未読の週次通知そのものは実装済み。「未読の週次通知」を参照）
- 保存済み記事の横断検索（同じスレッド内での質問応答は含む）
- GitHub上のクリップの整理（リネーム、削除）
- 興味傾向の分析

これらは将来候補として残すが、初期バージョンとは分けて設計する。GitHubを書き換えるツールをAIへ渡すときは、記事本文という第三者の書いた入力がAIの文脈に入っていることを前提に、実行前にSlackで確認を取る導線を必ず設ける。

## 未読の週次通知

初期バージョンの後に追加した（[ADR 0010](docs/adr/0010-weekly-digest-and-dismiss-bit.md)）。

- 読書状態は `dismissed_at` の1ビットだけを持つ。「既読／未読」という状態は持たず、UIのラベルも読んだかどうかを主張しない語にする。Dismissを理由別に割らない。
- 状態の正本はCloudflare D1に置き、1テーブル8列（`path` / `url` / `title` / `excerpt` / `image_url` / `clipped_at` / `last_shown_at` / `dismissed_at`）とする。定義は [`schema.sql`](schema.sql)。D1はクリップの台帳ではなくGitHubへの注釈レイヤーで、母集団もこれらの値もGitHubのクリップから再構成できる。
- 日曜9時（JST）にSlackのDMへ、未Dismissのクリップをちょうど7件投稿する。並び順は「未提示が最優先、その中では新しい順、既提示は最も長く出していない順」の1本で表す。出した分に `last_shown_at` を打つラウンドロビンで、提示回数は数えない。未Dismissが0件のときも投稿し、cronが落ちたのか片付いているのかを受け手が区別できるようにする。
- この巡回自体が、数か月後に記事を再発見する恒久的な導線を兼ねる。専用の検索UIや一覧画面は作らない。
- Dismissの入口は、ダイジェストの行ごとのボタンと、スレッドでの自然文（AIの `set_clip_dismissed` ツール）の2つ。どちらも単体のみを対象とし、一括操作は用意しない。ボタン押下はAIを経由せず直接D1を更新する。
- GitHubから手で消したクリップとD1の孤児行を突き合わせない。1度だけダイジェストに出るが、ボタンを1回押せば消える。GitHubを読むのはバックフィルと復旧のときだけにする。
- 1件は section（タイトルのリンクと抜粋、`accessory` にサムネイル）+ actions（片付けるボタン）+ context（ホスト名・保存時期）の3ブロックで出す（[ADR 0011](docs/adr/0011-digest-rows-with-excerpt-and-thumbnail.md)）。表示に使う値は保存時にD1へ複製し、ダイジェスト生成時にGitHubや記事サイトを読まなくても組み立てられるようにする。
- サムネイルの `og:image` だけは、投稿前に到達性を確かめる。Slackは取得できない `image_url` を渡すとメッセージ全体を拒否するため、渡す前にこちらで落とす。取れなかった行は画像なしで出し、ダイジェストの投稿自体は必ず行う。

## 取得内容の扱い

XはAPIから取得できる公開Postだけを対象とし、protected contentや位置情報は保存しない。著者と元URLをMarkdownに残し、保存先private repositoryの外へ再配布しない。Qiitaと一般Webも、利用者が指定したURLを個人利用のprivate repositoryへ保存する範囲に限定する。

## 初期バージョンの完了条件

- Slackへ送ったQiita、Zenn、X、一般WebのURLが、それぞれ定めた取得方法へ振り分けられる。
- 取得した内容がMarkdownとして指定のGitHubリポジトリへ保存される。
- Slackへ、記事のテーマと主な結論が分かる1〜2文の要約が返る。
- Slackの返信から、保存に成功したか失敗したかを判別できる。
- 取得できなかった内容を、取得できたものとして保存・要約しない。
- 同じスレッドで続けて質問すると、保存した記事の内容を踏まえた回答が返り、記事の再取得が起きない。

## 設計判断の記録

この設計書の方針を変更した判断は、[`docs/adr/`](docs/adr/) にADRとして残す。README.mdには結論と要約だけを書き、根拠・代替案・失うものはADR側に置く。

- [ADR 0001: Cloudflareのインフラ管理をOpenTofuではなくWranglerに寄せる](docs/adr/0001-wrangler-over-opentofu.md)
- [ADR 0002: Slack受信をワークスペースとユーザーのallowlistで制限する](docs/adr/0002-slack-allowlist.md)
- [ADR 0003: Zennの記事はZennの非公式APIから取得してMarkdownへ変換する](docs/adr/0003-zenn-unofficial-api.md)
- [ADR 0004: Slackへ返す要約は1〜2文の簡潔な一言にする](docs/adr/0004-concise-summary.md)
- [ADR 0005: 保存Markdownは記事タイトルのファイル名にし、フロントマターの直下を本文そのままにする](docs/adr/0005-title-based-file-name-and-plain-body.md)
- [ADR 0006: Slackの入力をすべてAIへ渡し、保存をツールにする](docs/adr/0006-agent-with-save-tool.md)
- [ADR 0007: スレッドの会話履歴をDurable Objectにツール結果ごと持つ](docs/adr/0007-thread-history-in-durable-object.md)
- [ADR 0008: AI SDKに乗せ、モデルの呼び出しをDurable Objectの外へ出す](docs/adr/0008-ai-sdk-and-model-calls-outside-the-durable-object.md)
- [ADR 0009: Web検索はGeminiのGoogle検索グラウンディングで行う](docs/adr/0009-google-search-grounding.md)
- [ADR 0010: 未読の週次通知のため、読書状態を `dismissed_at` の1ビットとしてD1に持つ](docs/adr/0010-weekly-digest-and-dismiss-bit.md)
- [ADR 0011: 週次ダイジェストの1件を、抜粋とサムネイル付きの3ブロックで表す](docs/adr/0011-digest-rows-with-excerpt-and-thumbnail.md)

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
- [AI GatewayのGoogle AI Studioプロバイダ](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/) — Stored Keys（BYOK）なら `cf-aig-authorization` だけで認証が通り、Gemini APIキーをリクエストに載せる必要がない
- [Gemini Thought Signatures](https://ai.google.dev/gemini-api/docs/thought-signatures) — 受け取った署名をそのまま次のリクエストへ返す必要がある。公式SDKを使わず履歴を組み立てる場合は自分で扱う
- [AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) — `stopWhen` でツール実行の往復を回し、`responseMessages` を会話へ追記する
- [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) — 検索はGemini側で実行され、結果は同じ応答に織り込まれる
- [Gemini API追加利用規約](https://ai.google.dev/gemini-api/terms) — グラウンディング利用時はSearch Suggestionsをそのまま表示することを求め、結果の再配信やキャッシュを制限している（エンドユーザーが閲覧するチャット履歴としての保存は例外）
- [Cloudflare AI Gateway Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) — プロンプトと応答本文の保存は既定で有効
- [Cloudflare AI Gateway Authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) — トークンは `AI Gateway Run` 権限のAPI tokenで、表示は一度きり
- [Cloudflare AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) — シークレット名は `{gateway_id}_{provider_slug}_{alias}` 形式
- [Cloudflare AI Gateway OpenTelemetry](https://developers.cloudflare.com/ai-gateway/observability/otel-integration/)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) — GitHub AppのJWT署名に必要なRSA署名を利用できる
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [GitHub公式：GitHub Appを選ぶ場合](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [GitHub Appのinstallation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) — 有効期限は1時間
- [GitHub Contents API](https://docs.github.com/en/rest/repos/contents) — リポジトリ内のファイルを作成・更新できる
