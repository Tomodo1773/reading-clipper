# ADR 0019: エージェントの返信をSlackのMarkdown blockで表示する

- ステータス: Accepted
- 日付: 2026-08-21

## 背景

エージェントにはSlack独自の`mrkdwn`を書かせ、返信を`section` blockへ入れていた。この方式では標準Markdownの`**太字**`、表、見出しなどが意図どおり表示されない。LLMは標準Markdownを自然に生成するため、プロンプトだけでSlack独自記法へ矯正するより、Slack側に変換を任せる方がよい。

Slackには標準Markdownを受ける方法として、`chat.postMessage`の`markdown_text`と、Block Kitの`markdown` blockがある。ただし`markdown_text`は`text`や`blocks`と併用できない。このアプリは保存直後の返信にDismissボタンを付けるため、`blocks`を外せない。

## 決定

エージェントの全返信を`type: "markdown"`のMarkdown blockへ入れる。保存が起きた返信では、その後ろに従来どおりDismissボタンの`actions` blockを並べる。

モデルにはSlack独自の`mrkdwn`ではなく標準Markdownを書かせる。リンクも`<URL|ラベル>`ではなく`[ラベル](URL)`を使う。トップレベルの`text`は、通知とblocksを読めないクライアント向けに返信本文をそのまま残す。

Markdown blockは1メッセージあたり合計12,000文字までなので、モデルにも同じ上限を指示する。ただしモデルの遵守を前提にはせず、送信するblockを組み立てる境界でも12,000文字へ省略する。上限を超えた返信は末尾を`…`に置き換え、Slackに拒否されるより、上限内の内容を確実に届ける方を選ぶ。

## 検討した代替案

- **保存の無い返信だけ`markdown_text`を使う**: ボタン付き返信との送信形式が分かれ、同じモデル出力の扱いが保存の有無で変わる。得られる表示はMarkdown blockと同じなので採らない。
- **`mrkdwn`のままプロンプトを強める**: LLMが生成しやすい標準Markdownを捨て、Slack固有記法への変換精度をモデルへ負わせ続けるため採らない。
- **標準Markdownをアプリ側で`mrkdwn`へ変換する**: 独自の変換処理とテストが増える。Slack自身が同じ変換を提供しているため採らない。

## 影響

- 太字、見出し、表、コードブロック、標準MarkdownリンクがSlackで表示される。
- SlackはMarkdown blockを受け取った後に複数のblocksへ変換することがある。ボタン押下時はSlackのpayloadに入ったblocksをそのまま更新へ使うため、変換後の形でも本文は保持される。
- 12,000文字を超えた返信の末尾はSlackへ表示されず、Durable Objectの会話履歴にだけ残る。モデルへの上限指示により通常は起きない防御的な経路として受け入れる。
- ADR 0006のうち、返信をSlack独自の`mrkdwn`で書く決定は本ADRで置き換える。
