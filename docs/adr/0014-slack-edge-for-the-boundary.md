# ADR 0014: Slackとの境界をslack-edgeに寄せ、Honoと自前の冪等キーを捨てる

- ステータス: Accepted
- 日付: 2026-08-17

## 背景

Slackとの境界にあたる部分を、署名検証からWeb APIの呼び出しまで自分で書いていた。内訳は `src/slack.ts` の167行と、`src/index.ts` のうちpayloadの型宣言・検証・分岐がおよそ100行である。

この層は「間違えても静かに壊れる」性質を持つ。署名検証が甘くても、payloadの絞り込みがずれても、平常時は正しく動いてしまう。自前で持ち続ける理由が薄い一方、間違えたときの代償は大きい。

### 実測した外部事情

| 対象 | 結果 |
|---|---|
| [Bolt for JavaScript](https://github.com/slackapi/bolt-js) v5.0.0（2026-07-15） | 依存に `express` と `raw-body` が残る。Node前提でWorkersでは動かない |
| [slack-edge](https://github.com/slack-edge/slack-edge) 1.3.17（2026-05-14） | 依存は `slack-web-api-client` の1つだけ。Workers・Deno・Bun・Node対応 |
| slack-edgeの素性 | 作者はSlackのSDK群を手がけていたKazuhiro Sera。ただし**現在はOpenAI在籍**で、リポジトリも `slackapi` ではなく独立した `slack-edge` org にある。**Slack公式でもCloudflare公式でもない** |
| slack-edgeの活動 | star 151、直近のコミットはもう1人のメンテナによる依存更新が中心 |
| `ctx.waitUntil` の実行時間 | 応答を返した後**30秒**まで（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)） |
| Queue consumerの実行時間 | **15分** |

「公式だから安全」という前提は成り立たない。それでも採る理由は、**Workersで動く公式の選択肢が存在しないこと**と、失うものが有界であること — ライブラリが止まっても、戻すのは自分で一度書いた150行程度である。

## 決定

### 境界層をslack-edgeへ移す

署名検証、`url_verification` への応答、payloadのパース、イベントとアクションの振り分け、自分の投稿から生じたイベントの除外、Slack Web APIの呼び出しを、すべてライブラリに預ける。`src/slack.ts` は削除する。

`SlackApp` に `routes.events` を渡さないと、パスの照合自体が行われず**未登録の任意のパスでも署名検証まで進んでしまう**（ライブラリ側のコメントに明記されている: "If the routes.events is missing, any URLs can work"）。実際に、Slackへ一度も登録していないパスへ署名付きリクエストを送ると処理されることを確認した。

### Request URLを1本へ統合する

`routes.events` が受け付けるパスは1つだけである。従来はEvent Subscriptions用とInteractivity & Shortcuts用でRequest URLを分けていたが、両方とも同じWorkerが受けている以上、2本を維持する意味は無い。**Slack App側の設定を変更し、両方を `/slack/events` 1本へ向ける。** slack-edgeはpayloadの型（イベントか、ボタン押下か）で自動的に振り分けるため、パスを分ける必要がそもそもない。

これにより、未登録パスの拒否をアプリ側の手書きコードではなく`routes.events`というライブラリの機能1行に任せられる。手書きの許可リストを持つ理由が無くなった。

### lazy listenerは使わない。Queueは残す

slack-edgeのlazy listenerは `ctx.waitUntil` で走るため**30秒**しか使えない。このアプリの処理は「記事の取得 → AIとツールの往復 → GitHub保存 → Slack返信」で、記事の取得だけで十数秒かかることがある。30秒はまず超える。

**15分使えるQueue consumerを残し、lazyハンドラではQueueへ積むまでしかやらない。** これは要件の都合ではなく実行時間の制約であり、Queueが与える再試行3回・dead letter queue・`max_concurrency: 1` の直列化もそのまま保たれる。

記事が「Slack AppをWorkersで動かす」構成として紹介しているのはlazy listener1本の形だが、その形はこのアプリでは成立しない。

### 一緒に捨てるもの

| 捨てるもの | 理由 |
|---|---|
| **Hono** | ルーティングをslack-edgeが持つと、残る仕事は `/health` だけになる。`/health` はリポジトリ内のどこからも参照されていない |
| **`client_msg_id` による投稿の重複排除** | Slackが文書化していないフィールドの挙動に、再試行時の安全性を預けていた。**標準から最も外れている部分** |
| **Slack呼び出しの自前10秒タイムアウト** | 防御的に足したもので、ライブラリのクライアントには設定項目が無い |
| **`already_reacted` を成功として扱う握り潰し** | リアクションはもともと「付かなくても本処理は続く」扱いで、専用の機構に見合わない |
| **`scheduled` と押下ハンドラのtry/catchログ** | 記録して投げ直すだけで、Workersランタイムが同じことをする |
| **ダイジェストのブロック型の自前定義** | `AnyMessageBlock` などライブラリの型に置き換える。`asRecord` でブロックを手探りする箇所も型で解けるようになる |

### 残すもの

- **ワークスペースとユーザーのallowlist**（ADR 0002）。slack-edgeの担当外なので、`beforeAuthorize` ミドルウェアとして持つ。`authorize()` の前に走るため、未許可のリクエストでは `auth.test` すら呼ばない
- **DMだけを受けるという絞り込み**。README が「SlackとのDM」を入口として定めているため、購読設定に頼らずコードでも保つ
- **`ClipError` によるQueueの再試行判定**。Slack APIのエラーは既定の「再試行可」に落ちる。従来も `callSlackApi` がHTTP 200 + `ok:false` を再試行可としていたため、実質の挙動は変わらない

## 検討した代替案

- **Queueを捨ててlazy listener1本にする**: 記事の構成そのままで、いちばん行数が減る。採らない理由は `waitUntil` の30秒制限。長い記事で黙って失敗するようになり、これは要件の切り下げではなく破損である。
- **`slack-cloudflare-workers` を使う**: Cloudflare向けの追加機能が入る。採らない理由は、その中身がKVによるOAuthのinstallation storeであること。単一ワークスペースの未配布アプリには要らない。
- **Honoを残し、slack-edgeをパーサーとしてだけ使う**: 変更が小さい。採らない理由は、Honoの担当が `/health` だけになり、依存を1つ増やしたうえで1つも減らないため。
- **`authorize` を自前で差し替え、`auth.test` の呼び出しを省く**: リクエストごとのSlack API呼び出しが1回減る。採らない理由は、自分の投稿を弾く判定に必要なbot IDを自分で持つことになり、削るはずの独自実装が別の場所へ戻るため。個人利用の流量では1回の増加は問題にならない。
- **`client_msg_id` を型のキャストで維持する**: 重複投稿が起きなくなる。採らない理由は、未文書の挙動への依存が残ること。個人用アプリで年に数回あるかどうかの重複と釣り合わない。
- **2本のRequest URLを維持し、アプリ側で許可パスの一覧を持つ**: Slackの管理画面を触らずに済む。採らない理由は、`routes.events`という同じ目的の機能がライブラリに既にあり、2本目を維持するためだけに手書きの絞り込みコードを持ち続けることになるため。パスを1本に減らせば、この手書きコードごと不要になる。

## 影響

- **境界層が377行（`slack.ts` 167 + `index.ts` 210）から89行へ減り、依存は `hono` が抜けて `slack-edge` が入る。** 処理の中核（Queue、スレッド履歴、取得系、ツール、ダイジェスト）は変わらない
- **Queueへの登録が失敗しても、Slackへ5xxを返して再送させる経路が無くなる。** lazyハンドラは応答を返した後に走るためである。Queueが落ちている間に送ったメッセージは、👀 が付いたまま返事が来ない。利用者は送り直せる
- **同じ返信が2回届くことがありうる。** Slackへの投稿だけが失敗して再試行された場合。モデルを二度呼ばないことと返信の中身が変わらないことは、`ThreadAgent` が `event_id` で保つ
- **リクエストごとに `auth.test` が1回増える。** 自分の投稿から生じたイベントを弾くために、ライブラリが呼ぶ
- **`url_verification` への応答がJSONから素のテキストへ変わる。** Slackはどちらも受け付ける
- **Slack APIへの送信がJSONからform urlencodedへ変わる。** ライブラリのクライアントがそうするため。テストのモックも `fetch(new Request(...))` の1引数で来るようになる
- **`SLACK_SIGNING_SECRET` が無いと、署名検証で401ではなく`SlackApp`の構築時に500になる。** 設定漏れが早く見える方へ倒れる。`scheduled` は `SlackApp` を作らないため、ローカルでのダイジェスト確認には影響しない
- **`/health` が無くなる。** 署名の無いPOSTが401を返すことで、Workerが動いていることは確認できる
- **ADR 0011 の「ダイジェストには冪等キーを渡さない」は、機構ごと無くなったため自動的に満たされる。** 判断そのものは変わらない
- **Slack App側の設定変更が要る。** Interactivity & ShortcutsのRequest URLを、Event Subscriptionsと同じ `/slack/events` へ変更する。変更を忘れるとボタン押下だけが404で失敗する。この変更はWorkerのデプロイとは独立して行う
