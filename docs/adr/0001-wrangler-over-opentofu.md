# ADR 0001: Cloudflareのインフラ管理をOpenTofuではなくWranglerに寄せる

- ステータス: Accepted
- 日付: 2026-08-15
- 関連: commit 61bf68b

## 背景

README.md の初版では、Cloudflareのインフラ管理にOpenTofuとCloudflare Providerを使う想定だった。分担は「Cloudflare Queueなど、Workerコードから独立した基盤はOpenTofu」「Workerコード、Queue bindings、Queue consumer設定は `wrangler.jsonc` とWrangler」とし、「OpenTofuとWranglerで同じリソースを重複管理しない」ことを制約に置いていた。実装手順の1番目も「OpenTofuで管理する基盤のIACを書く」だった。

IaCを書く前にCloudflare Provider v5の仕様を調べたところ、この分担が成立しないこと、および成立させても管理対象が痩せすぎることが分かった。

### Workerを宣言的に管理できない

- `cloudflare_workers_script` は `content`（コード本体）と `bindings` を必須属性として持つ。これを使うと、Workers Buildsによるデプロイと同じリソースを両側から書くことになり、「重複管理しない」制約に反する。
- v5には `cloudflare_worker` という、コードを持たないコンテナ資源もある（`name` / `observability` / `subdomain` / `tags` / `tail_consumers` / `logpush`）。一見すると「Workerコードから独立した設定」に見えるが、`wrangler.jsonc` も `observability` や `workers_dev` を同じキーで持ち、deploy時に上書きする。Cloudflareのダッシュボード自身が「wrangler設定を合わせろ」と警告を出す領域であり、正本が2つになる。

### 残る管理対象は3つしかない

分担を厳密に適用すると、初期バージョンでOpenTofuが持てるのは次の3つだけになる。

- `cloudflare_queue`（本体）
- `cloudflare_queue`（dead letter queue）
- `cloudflare_ai_gateway`

Queue consumerの設定（`max_batch_size` / `max_retries` / `dead_letter_queue`）は `cloudflare_queue_consumer` でも書けるが、`wrangler.jsonc` の管轄なので使わない。

### 3リソースに対してbootstrapが重い

state保存先を検討すると、恒久的に次を抱えることになる。

- state用のR2バケット（backendの初期化前に存在する必要があるため、これ自体はIaC管理外の手動作成になる）
- R2のS3互換APIトークン（Cloudflare API tokenとは別物。Access Key IDはtokenの `id`、Secret Access Keyはtoken valueのSHA-256で、再取得できない）
- OpenTofu state encryptionのpbkdf2 passphrase。紛失するとstateを復号できないため、保管とバックアップの運用が必要になる
- backend側の `encrypt` は `false` にする必要がある。client-side暗号化と併用するとOpenTofu issue #3041（ロック詳細取得時にSSE-Cキーが適用されず force-unlock できない）を踏む
- R2はフルオブジェクトのCRC-32等に非対応なので `skip_s3_checksum = true` が必須

### Wranglerに寄せたときに残る穴は1つだけ

| リソース | Wranglerで管理できるか |
|---|---|
| Worker本体・コード・bindings | できる（`wrangler.jsonc` が正本） |
| Queue（本体・DLQ） | できる（`wrangler queues create`） |
| consumer設定（batch / retries / DLQ） | できる（`wrangler.jsonc`） |
| runtime secrets | できる（`wrangler secret put`） |
| Secrets Store（BYOK用） | できる（`wrangler secrets-store`） |
| **AI Gateway** | **できない**（Wranglerにコマンドが無い） |
| Workers BuildsのGit連携 | **どちらの方式でもできない** |

## 決定

**OpenTofuを採用しない。`wrangler.jsonc` とWranglerを正本とし、AI Gatewayだけを冪等なスクリプトでコード化する。**

| 対象 | 管理方法 |
|---|---|
| Workerコード、Queue bindings、consumer設定、observability | `wrangler.jsonc` とWrangler |
| Queue本体とdead letter queue | `wrangler queues create` |
| AI Gateway | `scripts/setup-ai-gateway.ts` |
| runtime secrets | `wrangler secret put` |
| Gemini APIキー | Secrets Store経由のBYOK |
| Workers BuildsのGit連携 | ダッシュボードでの手動接続 |

`scripts/setup-ai-gateway.ts` はCloudflare APIを直接呼ぶ。ゲートウェイが無ければ `POST /accounts/{account_id}/ai-gateway/gateways`、あれば `PUT .../{id}` を投げる。`collect_logs: true`（プロンプトと応答本文の保存）と `authentication: true`（認証必須ゲートウェイ）をここで固定する。

### なぜスクリプトで妥協できるのか

宣言的でない点は劣るが、対象が1リソースであり、設定値がGitに残るという主目的は満たせる。一方でOpenTofuを維持した場合、この1リソースのためだけに前述のbootstrapを丸ごと抱えることになる。

## 代替案

### OpenTofuを維持する（当初案）

Queue、DLQ、AI Gatewayを宣言的に管理し、R2 backend + state暗号化を組む。`tofu plan` によるdrift検出と差分レビューが得られる点は本方式より優れている。

採用しなかったのは、得られるものが3リソースのdrift検出であるのに対し、払うコストがR2バケット・S3互換トークン・passphrase管理・バックアップ運用の恒久的な維持である点。1人規模のプロジェクトとして釣り合わないと判断した。

### Workerの「器」だけ `cloudflare_worker` で管理する

Workerの存在と `observability` / `subdomain` / `tags` をOpenTofu正本にし、`wrangler.jsonc` からはそれらのキーを省く案。IaCを見ればWorkerの存在が分かるようになる。

採用しなかった理由は2つ。`wrangler.jsonc` に書かれていない設定をdeployがどう扱うかが文書化されておらず、driftのリスクを実機検証なしには除けないこと。もう1つは、これを入れてもWorkers BuildsのGit連携は手動のままで「IaCで完結する」状態にはならないこと。

### AI Gatewayもダッシュボードで手動作成する

最も手数が少ない。採用しなかったのは、`collect_logs` や `authentication` が誰かに変更されても気づけず、再現手順が文章だけになるため。README の「AI Gatewayでプロンプトと応答本文を含むログを保存する」という要件を担保する手段が無くなる。

## 影響

### 良い面

- state、R2バケット、S3互換トークン、暗号化passphraseがすべて不要になる。README の未決事項「OpenTofu stateの保存先とバックアップ方法」が消滅した
- ツールがWrangler1つに揃い、「この設定はどちらの正本か」を都度考えなくてよくなる
- 言語がTypeScriptに統一される

### 注意する面

- **drift検出の手段が無くなった。** `tofu plan` に相当するものは無く、ダッシュボードで設定を変えられても検知できない。AI Gatewayについては `pnpm setup:aigw` を再実行すれば設定が戻る（冪等なので安全）が、実行は手動で、差分は表示されない
- **Workers BuildsのGit連携はコード化できない。** Cloudflare Providerが未対応（[issue #6924](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6924)、2026-03起票・未対応）で、Builds API自体は対応しているがproviderが公開していない。ダッシュボードでの手動接続が必要で、この制約はOpenTofuを採用しても解消しなかった
- **AI Gatewayの認証トークンはゲートウェイ単位に絞れない。** `AI Gateway Run` 権限のCloudflare API tokenであり、アカウント内の全ゲートウェイに及ぶ。また発行時に一度しか表示されないため、取得は自動化しない（スクリプト出力やCIログに残るため）。ダッシュボードで発行し `wrangler secret put AI_GATEWAY_TOKEN` で登録する
- **BYOKのシークレット名は形式が決まっている。** `{gateway_id}_{provider_slug}_{alias}`（例: `reading-clipper-summarizer_google-ai-studio_default`）。ゲートウェイはこの命名規約で自動的に引くため、名前を外すと黙って効かない。登録後はWorkerがGeminiのAPIキーを持つ必要がなくなる
- **ゲートウェイIDが2箇所にある。** `wrangler.jsonc` の `vars.AI_GATEWAY_ID` と `scripts/setup-ai-gateway.ts` の `GATEWAY_ID`。JSONCはコメントを含むためNodeで安全にパースできず、スクリプトから読み込めなかった。片方を変えたらもう片方も変える
- **Queueは先に作る必要がある。** `wrangler.jsonc` に `dead_letter_queue` を書いてもwranglerが自動作成するとは文書化されていない。自動プロビジョニングはbeta（wrangler 4.45.0以降）なので、`wrangler queues create` で明示的に作る
- **`compatibility_date` は同梱workerdの対応日以下にする。** 超えると `wrangler dev` が `Compatibility date "..." is in the future and unsupported` で起動しない。`deploy --dry-run` は通ってしまうため、CIでは検出できない。共通ポリシーの `minimumReleaseAge: 10080` によりwranglerは7日以上前のものが入るので、上限は常に「今日」より前になる。実際に初回コミットで踏んだ（wrangler 4.120.0 の workerd は 1.20260801.1 で、`2026-08-15` を指定していた）
- **依存の最新版は入らない。** `minimumReleaseAge: 10080` により公開7日未満は除外される。`ERR_PNPM_NO_MATURE_MATCHING_VERSION` はこの設定が働いた結果なので、緩めて回避せず7日以上前のバージョンを指定する
- **AI Gatewayの `log_management`（ログ保存上限）は指定していない。** プランごとに既定値が異なり、上限を超える値を指定すると拒否される可能性があるため、Cloudflare側の既定に任せた。`log_management_strategy: "DELETE_OLDEST"` だけを設定し、上限到達時に古いログを消す
- Workerのobservability設定は `wrangler.jsonc` が正本になった。ダッシュボードで変えてもdeployで戻る
