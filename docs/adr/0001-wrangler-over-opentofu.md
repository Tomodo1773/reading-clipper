# ADR 0001: Cloudflareのインフラ管理をOpenTofuではなくWranglerに寄せる

- ステータス: Accepted（現行運用を記録する。OpenTofu移行の採否は未決定）
- 日付: 2026-08-15
- 再評価: 2026-08-30
- 関連: commit 61bf68b

## 背景

初期実装では、Workers BuildsとWranglerをデプロイの正本にし、Cloudflareの独立した基盤だけをOpenTofuで管理する案を検討した。WorkerコードとbindingsをWorkers BuildsとOpenTofuの両方から更新すると正本が二つになるため、当時はOpenTofuを採用せず、Wrangler、Cloudflare APIを呼ぶスクリプト、ダッシュボード上の設定へ管理を分けた。

## 2026-08-30の訂正

初版は「Wranglerとの重複を避けるとOpenTofuで管理できるのはQueue、DLQ、AI Gatewayだけ」と評価した。この評価を現在のCloudflare Providerへそのまま適用するのは誤りである。

Cloudflare Provider v5.24.0では、このサービスが使うCloudflare資源の大半にresourceがある。

| 対象 | 現在のProvider対応 |
|---|---|
| Workerの器、observability、workers.dev設定 | [`cloudflare_worker`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/worker) |
| Workerコード、version、bindings、Service Binding、Durable Object migration | [`cloudflare_worker_version`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/worker_version) と [`cloudflare_workers_deployment`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_deployment)。従来型の[`cloudflare_workers_script`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_script)でも管理できる |
| Queue、DLQ、consumer設定 | [`cloudflare_queue`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/queue) と [`cloudflare_queue_consumer`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/queue_consumer) |
| D1データベース本体 | [`cloudflare_d1_database`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/d1_database) |
| AI Gateway | [`cloudflare_ai_gateway`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/ai_gateway) |
| Worker Custom Domain | [`cloudflare_workers_custom_domain`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/workers_custom_domain) |
| Access application、policy、Managed OAuth設定 | [`cloudflare_zero_trust_access_application`](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/zero_trust_access_application)。`oauth_configuration`を持つ |
| Secrets Storeと格納するsecret | `cloudflare_secrets_store`と`cloudflare_secrets_store_secret` |

したがって、Workers Buildsをやめ、CIで生成したWorker bundleをOpenTofuからdeployする方式へ変えるなら、Cloudflareの継続的な構成管理は大部分をOpenTofuへ統一できる。初版の「管理対象が3リソースしか残らない」という前提は、現在の不採用理由にはならない。

一方、「Cloudflare関連をすべてOpenTofuだけで管理できる」とも言えない。

- `cloudflare_d1_database`はデータベース本体を管理するが、`schema.sql`の実行やmigrationは管理しない。別のmigration runnerが要る。
- Workers Buildsには[repository connectionとtriggerを操作するAPI](https://developers.cloudflare.com/api/resources/workers_builds/)があるが、Provider v5.24.0には対応resourceがない。Workers Buildsを維持する場合、この部分はProvider外に残る。
- TypeScriptのbundleと依存取得はOpenTofuの責務ではない。CI等で成果物を作る工程が必要になる。
- OpenTofuを実行するCloudflare API tokenとstate backendは、OpenTofuより先に用意する必要がある。
- secret resourceやsecret bindingは管理できるが、secret値の供給元とstateへの保存方針は別途決める必要がある。

## 現在の決定

このADRは、現在の実装が次の管理方式を採っている事実を記録する。

| 対象 | 現在の管理方法 |
|---|---|
| Workerコード、bindings、consumer設定、cron、observability | `wrangler.jsonc`、`wrangler.mcp.jsonc`とWorkers Builds |
| Queue本体とdead letter queue | `wrangler queues create` |
| D1データベース本体 | `wrangler d1 create` |
| D1 schema | `wrangler d1 execute` |
| AI Gateway | `scripts/setup-ai-gateway.ts` |
| runtime secrets | `wrangler secret put` |
| Gemini APIキー | Secrets Store経由のBYOK |
| Custom Domain、Access、Managed OAuth、Workers BuildsのGit連携 | ダッシュボードと実環境の手動設定 |

OpenTofuへ移行するか、この混合管理を維持するかは、このADRでは決めない。移行する場合は、Workers Buildsを残すか廃止するか、Workerのbuild/deploy境界、D1 migration、secretとstateの保護、既存resourceのimport方法を検討し、別のADRで決定する。

## 現行方式の影響

- WranglerとWorkers Buildsによる現在のデプロイをそのまま維持できる。
- AI Gatewayは`pnpm setup:aigw`を再実行すれば設定を戻せる。
- OpenTofuの`plan`に相当する、環境全体のdrift検出はない。
- Workers Builds、Custom Domain、Access、Managed OAuth、secret、D1 schemaの適用状態は、repositoryだけから再構成・検証できない。
- AI Gateway IDは`wrangler.jsonc`と`scripts/setup-ai-gateway.ts`の2箇所にあり、片方を変えたらもう片方も変える必要がある。
- `wrangler.jsonc`の`compatibility_date`は同梱workerdの対応日以下にする。`deploy --dry-run`だけでは未来日の問題を検出できないため、変更時は`pnpm dev`の起動も確認する。
