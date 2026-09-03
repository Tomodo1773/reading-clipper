# ADR 0021: MCP公開境界を専用Workerへ分離し、Access Managed OAuthで保護する

- ステータス: Accepted（実装済み。閲覧ページの分離と監査情報の受け渡しは[ADR 0036](0036-split-the-clip-page-into-its-own-worker.md)で更新）
- 日付: 2026-08-24

## 背景

Reading Clipperのツールを、現在のSlack Botとは別のSlack Botからremote MCPとして使いたい。

既存WorkerにはSlack署名検証、Queue consumer、cron、AI呼び出し、GitHub Appの秘密情報、D1、Durable Objectsが同居している。ここへ公開MCP endpointとOAuth処理まで直接足すと、公開境界と秘密情報を持つ実行境界が同じになる。また、Cloudflare DNSで管理する同一zone内のWorker同士を公開hostname経由で呼ぶと、Custom DomainとWorker Routeの違いによって通信可否が変わる。

MCPクライアントは別のSlack Botであり、ブラウザを常時持たない。Cloudflare Accessの通常のlogin redirectではなく、非ブラウザクライアントが完了できるOAuth flowが必要になる。

## 決定

### Workerを公開境界と実処理に分ける

同じrepositoryから、次の2つを別Workerとしてdeployする。

| Worker | 責務 | 持たせるもの |
| --- | --- | --- |
| **Bot/Core Worker** | 現在のSlack受付、Queue consumer、cron、AI turn、ツールの実処理 | GitHub Appなど既存secret、D1、Durable Objects、fetcher |
| **MCP Edge Worker** | Streamable HTTPの`/mcp`、MCP schema、Access認証結果の検証、Core RPCへの変換 | Custom Domain、Accessとの境界、CoreへのService Binding |

MCP EdgeにはGitHub、Firecrawl、X、Slack Bot tokenなどの業務secretを置かない。MCP toolの実処理を複製せず、Bot/Core Workerのprivate RPC entrypointを呼ぶだけにする。

通常のReading Clipper Botは自分自身の公開MCP endpointを呼ばない。Bot用AI SDK toolsとMCP toolsは、どちらも同じCoreのuse caseを呼ぶ。これによりツールの意味を揃えつつ、通常BotへOAuth・HTTP・MCP serializationの往復を持ち込まない。

```text
現在のSlack ──Events──> Bot/Core ──Queue──> AI tools ──┐
                                                          ├──> Core use cases / ToolState
別のSlack Bot ──HTTPS + MCP + OAuth──> MCP Edge ──RPC───┘
```

別のSlack Botはこのrepositoryのdeploy対象ではなく、外部MCPクライアントとして扱う。

### 公開通信と内部通信を混ぜない

- 別のSlack BotからMCP Edgeへは、必ず公開HTTPSのMCP endpointを呼ぶ。この経路でCloudflare Access Managed OAuthを通す。
- MCP EdgeからBot/CoreへはService BindingのRPCを使う。Custom Domain、DNS、公開HTTPを経由しない。
- MCP Edgeのhostnameは、DNSへCNAMEを手で作ってWorker Routeを重ねる方式ではなく、Worker自身をoriginにする**Custom Domain**として設定する。
- MCP Edgeでは`workers.dev`とpreview URLを無効にし、Accessを通らない別名の公開endpointを作らない。
- 同一zoneのWorkerからCustom Domainへの`fetch()`はCloudflareが対応しているが、内部呼び出しは意図せず公開認証を迂回・再実行しないようService Bindingへ固定する。

根拠:

- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Service bindings - HTTP](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
- [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)

### Cloudflare Access Managed OAuthを認証境界にする

- MCP EdgeのCustom Domain全体をCloudflare Access applicationで保護し、Managed OAuthを有効にする。
- Access policyではこの個人サービスの利用者だけをAllowする。OAuthを通ったことだけでなく、許可した本人であることをEdgeで確認する。
- MCP EdgeはCloudflare Workersが検証済みの`ctx.access`を使い、application audienceが設定値と一致することを確認する。JWTの署名検証やJWKS取得をアプリ内で重複実装しない。
- `ctx.access.getIdentity()`で得たemailが許可した本人と一致し、安定IDの`user_uuid`が存在するときだけCoreを呼ぶ。
- Service Bindingには`ctx.access`が自動伝播しない。Edgeは監査用の`source`と`user_uuid`だけをRPC引数として渡し、Coreは自身の`TOOL_OWNER_ID`を使う。EdgeやMCP requestからowner IDを受け取らない。
- OAuth access token、refresh token、Access JWTそのものはCoreへ渡さず、会話履歴やtool refにも保存しない。
- CoreのRPCは公開HTTP routeにせず、Service Bindingからだけ到達させる。RPC引数の監査情報は認証・認可境界として扱わない。

Managed OAuthはAccess policyを置き換える別の認証経路ではなく、非ブラウザクライアントが同じAccess policyを通るためのtransportとして使う。

根拠:

- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

### 別のSlack BotがOAuth client stateを持つ

OAuth client側の状態はMCP serverではなく、別のSlack BotのDurable Objectへ置く。

- object keyは`MCP server URL × Slack team_id × Slack user_id`
- authorization開始時にPKCE verifier、state、redirect先を保存する
- Slackへauthorization URLを返し、利用者がブラウザでAccess loginを完了する
- callbackは別のSlack Bot自身のHTTPS endpointで受ける
- access token、refresh token、有効期限を同じobjectへ保存し、必要時にrefreshする
- tokenやPKCE verifierをSlack message、モデルの会話履歴、MCP tool resultへ入れない

会話履歴とOAuth tokenは用途が違うため、同じtableや同じrecordへ混在させない。

### MCP tool callは同期で処理する

- 通常のMCP tool callは、MCP EdgeからCore RPCへ直接渡して同じHTTP request内で結果を返す。
- MCP EdgeとCoreの間にQueueを置かない。Queueへ渡すとMCP responseとの相関、結果保存、pollingまたはMCP Tasksが必要になり、現在の処理には過剰になる。
- 現在のSlack Events API受付では、3秒以内のACK、再試行、dead letter queueのため既存Queueを残す。
- 別のSlack BotがSlack Eventsをどう非同期化するかは、そのBot側の責務でありMCP serverのQueueとは共有しない。
- 将来、1回のHTTP requestで完了できない長時間処理を公開するときだけMCP TasksとQueueを再検討する。

## 検討した代替案

- **既存Workerへ`/mcp`を同居させる**: deployは1つで済む。ただし公開MCP parserと認証境界が全業務secretを持つWorkerへ入り、Access設定の誤りがCoreへ直結する。変更・rollbackの単位も分けられない。
- **別のSlack BotからService BindingでMCP Edgeを呼ぶ**: 同一accountなら通信は簡単になる。ただしAccess Managed OAuthと公開MCP transportを通らず、「外部MCP clientとして接続できる」ことの検証にもならない。
- **MCP EdgeからCoreのCustom Domainを`fetch()`する**: true Custom Domainなら同一zoneでも動く。しかし内部通信がDNS、公開routing、Access policyに結合し、利用者向け入口と内部境界が混ざる。
- **通常Botも自分のremote MCPを呼ぶ**: tool contractは見かけ上一本になる。ただし内部処理へOAuth、公開network、MCP encodingを追加し、自サービスの公開endpoint障害で既存Botまで止まる。
- **独自OAuth providerをWorkerへ実装する**: policyを完全に制御できる。一方、個人サービスのためにclient registration、token発行、refresh、失効を所有することになる。Access Managed OAuthで同じ本人制限を満たせるため採らない。
- **すべてQueueへ積む**: retryと直列化を共通化できるが、通常のMCP同期応答を壊す。長時間toolが実際に必要になるまで導入しない。

## 影響

- Worker deploymentが2つになり、Coreを先、MCP Edgeを後にdeployする依存が生まれる。
- Custom Domain、Access application、Managed OAuth、Service Bindingの設定が増える。
- 外部MCP endpointから業務secretとstorage bindingを切り離せる。
- DNSやCustom Domainの問題は外部client→MCP Edgeの公開経路に限定され、Edge→Coreの内部処理には波及しない。
- MCP clientは標準OAuth flowを実装し、browser loginのためのauthorization URLとcallbackを扱う必要がある。
- Access policyとアプリ内のowner対応は単一利用者を前提とする。複数利用者へ広げる場合は、owner分離、認可、監査を改めて設計する。

## 実装時の完了条件

- `ctx.access`なし、audience不一致、許可外identityのいずれでもCore RPCが実行されない。
- 想定外のHostまたはOriginではMCP handlerを実行しない。
- 公開hostnameはCustom Domainだけで、`workers.dev`、preview URL、別routeから`/mcp`へ到達できない。
- 別のSlack Botから公開hostnameへOAuth付きで接続できる。
- MCP Edgeを経由したtool resultと通常Botの同名tool resultが同じ意味を持つ。
- MCP EdgeのbindingsとsecretsにGitHub App等のCore secretが存在しない。
