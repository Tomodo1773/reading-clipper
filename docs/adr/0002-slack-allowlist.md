# ADR 0002: Slack受信をワークスペースとユーザーのallowlistで制限する

- ステータス: Accepted
- 日付: 2026-08-15

## 背景

Slackの署名検証は、リクエストがSlack Appの署名鍵で署名されたことを確認するだけで、メッセージを送ったSlackユーザーの認可にはならない。DMだけを受け付け、Botメッセージを除外しても、同じワークスペースの他メンバーからの利用は止められない。

このサービスは保存先private repositoryへ内容を書き込むため、Slack Appをインストールできることと、サービスを利用できることを分離する必要がある。

## 決定

Slack Events APIの`event_callback`について、次の両方を満たす場合だけ処理する。

- エンベロープの`team_id`が`SLACK_ALLOWED_TEAM_ID`と一致する
- `event.user`が`SLACK_ALLOWED_USER_ID`と一致する

署名検証、DM判定、Bot除外に加えてallowlistを入口で確認し、未許可のイベントは`200 {"ok":true}`だけ返す。未許可ユーザーへ返信せず、Queueにも登録しない。Slackの再送を避けつつ、許可状態を外部へ明かさないためである。allowlistが空またはイベントに必要なIDがない場合はfail closed（全拒否）とする。

初期版は単一ワークスペース・単一ユーザー用の未配布Slack Appとし、runtime secretで許可IDを管理する。複数ユーザー対応や複数ワークスペースへの配布は、必要になってから設計する。

## 影響

- Slack Appをインストールしただけではサービスを利用できず、明示的に登録したユーザーだけが利用できる。
- 利用者を変更するときは`SLACK_ALLOWED_USER_ID`を更新する必要がある。
- Slack user IDとteam IDはGitに保存せず、Wrangler secretとして設定する。
- 複数ワークスペース対応にはOAuthとインストール情報の永続化が必要になる。
