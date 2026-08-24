# ADR 0022: ツール参照をDurable Objectへ90日保持し、BotとMCPで共通化する

- ステータス: Accepted（実装済み）
- 日付: 2026-08-24

## 背景

現在の`load_content`と`save_loaded`、`find_clips`と`read_clip` / `delete_clip`は、1回の`generateText()`中に作られるJavaScriptの`Map`を共有して成立している。同じWorker invocation内では、外側のWorkerやMCP transportがstatelessでもMapは消えない。

一方、Slackで「まず本文だけ取得して」、次のmessageで「では保存して」と分けると、次のinvocationにはMapが無い。検索した次のmessageで削除する場合も同じである。現在問題になりにくいのは、保存と削除を1ターンで完了させるpromptと運用に限定しているからであり、Slack Botが一般にstatefulだからではない。

remote MCPではrequestやconnectionをまたいで同じ制約が表面化する。MCP固有の問題として別実装を足すのではなく、通常BotとMCPの両方を自然な複数ターンのtool contractへ揃える。

## 決定

### tool contractは入口によらず同じにする

通常BotとMCP Edgeは同じtool名、入力、出力、Core use caseを使う。MCP化を理由に名前を変えない。

| tool | contract |
| --- | --- |
| `load_content(url)` | 本文を取得し、全文とopaqueな`loaded_ref`を返す。保存しない |
| `save_loaded(loaded_ref)` | refに保存された**取得時点の本文snapshot**を保存する。再取得しない |
| `find_clips(query)` | GitHubを検索し、各候補へopaqueな`clip_ref`を付けて返す |
| `read_clip(clip_ref)` | refが指すpathの現在の本文をGitHubから読む |
| `delete_clip(clip_ref)` | refが指すpathをGitHubとD1から削除する |
| `set_clip_dismissed(path, dismissed)` | 現在と同じ。D1に実在するpathだけを単体で更新する |

`delete_clip`もMCPへ公開する。個人用サービスであり、現在の通常Botと同じく、検索結果から発行されたrefだけを受け付け、1回1件、Gitの履歴から復元可能という制約を維持する。

Geminiのprovider toolである`google_search`はMCP serverの機能ではないため公開しない。別のMCP clientが検索を必要とする場合は、そのclient自身の検索toolを使う。

### opaque refをToolState Durable Objectへ置く

ownerごとに`ToolState` Durable Objectを1つ作り、`idFromName(ownerId)`で引く。単一利用者の通常BotとCore RPCは、Coreに設定した同じ内部`ownerId`を使う。MCP EdgeやMCP requestから任意のowner IDは受け取らない。

概念schemaは次のとおり。

```sql
CREATE TABLE tool_refs (
  ref          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL, -- loaded | clip
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
```

- refは十分なentropyを持つrandomな文字列にし、連番、URL、path、titleから推測できない値にする。
- refはownerとkindへ束縛する。別owner、違うkind、期限切れ、存在しないrefでは処理せず、構造化した失敗を返す。
- `loaded_ref`のpayloadには`FetchedContent`をそのまま保存する。同じURLを再度loadした場合も新しいrefを発行し、過去のsnapshotを上書きしない。
- `clip_ref`のpayloadには後続処理に必要なpathと、削除結果に使うtitleだけを保存する。検索結果のURLやsnippetなどはrefへ重複保存しない。
- refは恒久的なclip IDではない。90日で失効し、再発行は`load_content`または`find_clips`から行う。
- `read_clip`と`delete_clip`はrefのpathを使う直前にGitHubへアクセスする。検索後にファイルが消えた場合は`missing`として扱い、refが現在の実在を保証するとは考えない。

MCPのsession IDやOAuth access tokenをrefの置き場所にしない。どちらも更新・切断・失効しうるtransport stateであり、会話をまたぐ業務状態の正本にはしない。

### 通常BotもMapをやめて同じToolStateを使う

- 通常Botの`createTools()`も、`loaded`と`foundClips`のin-memory MapではなくToolStateへ書き、refで読み出す。
- AI呼び出し自体はこれまでどおりQueue consumer側に置き、Durable Objectへ移さない。ToolStateが持つのはtool間の状態だけである。
- 1ターン目の`load_content` resultに本文と`loaded_ref`が残るため、2ターン目の「それを保存して」でモデルは`save_loaded(loaded_ref)`を呼べる。
- 1ターン目の`find_clips` resultに`clip_ref`が残るため、後のmessageでも`read_clip`または明示的な削除依頼へ使える。
- 別のSlack Botは自身の会話履歴へMCP tool resultを保存する。MCP serverはclientの会話履歴を持たず、refの解決だけを担当する。

この変更は[ADR 0012](0012-load-content-then-save-loaded.md)の「ターン内のMap」、[ADR 0016](0016-delete-clip-via-search-and-turn-scoped-ref.md)と[ADR 0020](0020-search-and-read-saved-clips-via-github.md)の「そのターンだけ有効な番号」を置き換える。読む→保存する、探す→読む／消すという順序そのものは維持する。

### 会話履歴とrefは90日で削除する

Slack無料プラン上で利用者が参照できる最近90日の会話に、アプリ側の保持も合わせる。

90日保持の対象:

- `ThreadAgent`の会話turn
- 処理済みSlack event、保存済み返信、返信に紐づくclip情報
- `loaded_ref`と本文snapshot
- `clip_ref`
- 別のSlack Botが持つ会話履歴

対象外:

- private GitHub repositoryのMarkdownとGit履歴
- D1のdismissed状態とclip注釈
- `clips/README.md`
- OAuth refresh tokenの保持期間。これはAccessのgrantとclient側の再認証方針で別に決める

Durable Objectsにrecord単位の自動TTLがあるとは仮定しない。各rowに時刻を持ち、Alarm APIを使ってアプリ側で削除する。

- 書き込み時に`expires_at = created_at + 90日`を設定する
- objectにalarmが無ければ、最も早い期限へalarmを設定する
- `alarm()`で期限切れrowを削除し、残る最小`expires_at`へ再設定する
- `ThreadAgent`ではmessage単位ではなくturn単位で同時に消し、tool callとtool resultを分断しない
- cleanupは冪等にし、途中失敗しても次のalarmまたは次回書き込みで再設定できるようにする

根拠:

- [Durable Object Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Durable Object Time To Live example](https://developers.cloudflare.com/durable-objects/examples/durable-object-ttl/)

### GitHub書き込みの追加直列化はしない

ToolStateのSQL操作はDurable Object内で整合させるが、GitHubへの保存・削除全体をDO lockで囲まない。

Durable Objectはsingle-threadedでも、外部`fetch()`を`await`している間は別requestが進みうる。したがってDOへ置くだけで`GET sha → PUT/DELETE → D1 → index更新`全体が自動的に直列化されるわけではない。一方、`blockConcurrencyWhile()`で外部I/O全体を囲むと30秒制限とhead-of-line blockingを持ち込む。

このサービスは単一利用者で、同じclipへのmutationを意図的に並列実行しない。GitHub Contents APIには既存SHAを渡しているため、競合はsilent overwriteではなく409などのtool failureとして表面化する。次の方針で始める。

- 現在のSlack Queueの`max_concurrency: 1`はそのまま残す
- MCP callは同期で直接処理し、mutation用のQueueやlockを足さない
- `blockConcurrencyWhile()`を外部GitHub callの直列化には使わない
- 競合時は成功扱いにせず、tool failureとして返す
- 実際に競合が観測されたら、対象operationだけのretry、またはowner単位のPromise queueを追加する

根拠:

- [Avoid race conditions with non-storage I/O](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#avoid-race-conditions-with-non-storage-io)
- [`blockConcurrencyWhile()`](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)

## 検討した代替案

- **canonical URLやpathをそのままキーにする**: 新しいrefを発行せずに済む。しかし同じURLを複数回loadしたsnapshotを区別できず、モデルが本文やtitleからpathを組み立てられる。保存対象を「実際にloadした本文」へ固定する能力も弱い。
- **現在と同じturn-scoped MapをMCPにも使う**: storage追加が無い。ただし通常Botでも複数turnに分けると消え、MCP connectionやrequestの寿命へtool contractが依存する。
- **D1のclipへ恒久IDを足す**: refが安定するが、GitHubにだけ存在するclipを扱うための同期とbackfillが必要になる。欲しいのはclipの主キーではなく、特定のtool resultを後続toolへ安全に渡す一時capabilityである。
- **refを会話履歴から毎回再構成する**: 本文と検索結果は履歴にあるが、モデル出力をstorageとして信頼し、任意のpathを組み立てられる状態へ戻る。履歴の実装が異なるMCP clientとも揃わない。
- **通常Botも公開MCP経由にする**: [ADR 0021](0021-publish-tools-through-mcp-edge.md)のとおり、wire protocolを揃えるためだけに自サービスへのOAuthとnetwork dependencyを増やす。Core use caseとToolStateを共有すれば意味は揃う。
- **すべてのmutationをDOで直列化する**: 将来の複数利用者やbulk操作には有効だが、現在は単一利用者で競合を観測していない。外部I/Oを含むlockとtimeout処理を先に所有しない。
- **保持期限を設けない**: 実装は最も簡単だが、利用者がSlackから参照できない古い会話と本文snapshotをCloudflare側だけへ残し続ける。

## 影響

- `load_content`の本文snapshotが会話履歴とToolStateの両方に入り、DO storage使用量が増える。
- 通常Botでも、取得と保存、検索と読取／削除を別messageへ分けられる。
- MCP transportがstatelessでも、refはOAuth token更新やconnection切断を越えて90日使える。
- 90日を越えた操作は再loadまたは再検索が必要になる。
- 削除の「直前に同じturnで検索した」という従来の強い制約を失う。代わりにopaque、owner-bound、期限付き、単体操作、Gitで復元可能という境界で守る。
- Alarm scheduling、期限切れcleanup、ref kind検証の実装とtestが増える。
- 書き込み直列化を持たないため、稀な競合はtool failureとして利用者に見える。

## 実装時の完了条件

- 通常Botで`load_content`と`save_loaded`を別のSlack messageへ分けても、再取得せず同じsnapshotが保存される。
- 通常BotとMCPの両方で、検索後の別turnから`read_clip`と`delete_clip`が使える。
- ref文字列からURL、path、titleを推測できず、違うkind・owner・期限切れrefは作用を起こさない。
- 90日を超えたThreadAgent rowとtool refがalarmで削除される。
- MCPから`delete_clip`を呼べるが、pathを直接渡して削除する経路は存在しない。
- 同一pathへの競合はsilent successにならず、409相当の失敗として観測できる。
