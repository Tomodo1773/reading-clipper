# Reading Clipper

SlackへURLを送るだけで、記事の保存・要約・再発見までをまとめて扱える個人用リーディングクリッパー。

![Bot/Core Workerの内部構成](docs/architecture/architecture.svg)

## 概要

Reading Clipperは、アプリやブラウザの共有メニューからSlackへ送ったURLを読み取り、Markdownとしてprivate GitHubリポジトリへ保存するサービス。保存直後にAIが内容を短く要約し、同じSlackスレッドで記事について質問できる。

読まないと決めた記事は、保存直後の返信やWebの一覧からその場で片付けられる。片付けていないクリップは毎週Slackへ再掲されるため、保存したまま忘れがちな記事にも自然に戻れる。クリップと会話はSlackだけで完結し、まだ片付けていないクリップはGitHubを開かずにWebで全件眺められる。

## 開発の背景

読みたい技術記事はZenn、X、Qiitaなど複数のプラットフォームに散らばり、それぞれのブックマークへ保存すると一覧性がなくなる。さらに、保存した記事が再び目に入る機会がなく、積読になりがち。

そこで、入口を普段使っているSlackへ一本化し、本文はGitHubへ蓄積、AIによる要約と週次ダイジェストで読むきっかけを作るサービスとして開発。通常のWeb取得では扱いづらいXの公開PostをAPI経由で読めることも、個人用ツールとして重視している。

## 主な機能

- **Slackからすぐにクリップ**
  スマートフォンのアプリやブラウザの共有メニューから、URLをSlack AppのDMへ送るだけで受け付ける。
- **URLに応じた本文取得**
  Qiita、Zenn、Xの公開Post、arXivの論文、Speaker Deckとドクセルのスライド、一般のWebページをそれぞれに適した方法で取得。リダイレクトURLにも対応。
  arXivは入口のページではなくLaTeXML版の全文HTMLから取るため、アブストラクトではなく論文の中身が残る。
  スライドは本文のHTMLを持たないため、公開されているテキストの範囲でクリップする。Speaker Deckは1枚ずつの文字起こしまで、ドクセルは投稿者の概要までが上限で、**どこまで取れたかは本文の末尾に書き残す**（[ADR 0025](docs/adr/0025-slides-clipped-within-published-text.md)）。
- **紹介投稿から本命の記事を保存**
  Xの短い投稿がブログ記事を紹介している場合、AIが投稿本文を読んだうえでリンク先も取得し、紹介投稿ではなく記事本体をクリップする。
- **要約とスレッド内の質問応答**
  保存時に1〜2文で要約し、続けて質問すると取得済みの本文を踏まえて回答。同じスレッドでは記事を取り直さない。
- **MarkdownをGitHubへ保存**
  記事本文と出典情報をMarkdownへ整え、GitHub App経由で指定したprivateリポジトリへ保存。
- **日本語でない記事は保存の後で日本語へ**
  AIが本文を読んだ時点で日本語以外だと分かった記事は、保存の直後に翻訳を積み、本文を訳文へ置き換える。クリップの返信を待たせないよう非同期で走るため、ファイルが日本語になるのは保存の数分後になる。原文は同じパスの1つ前のコミットに残り、題名とファイル名は原題のまま変えない（[ADR 0027](docs/adr/0027-translate-clips-into-japanese-after-saving.md)）。
- **まだ片付けていないクリップを、ブラウザで全件見る**
  認証付きのWebページに、まだ片付けていないクリップを**全件**、新しい順で並べる。サムネイルと冒頭の抜粋、ホスト、保存日を添え、タイトルから元の記事へ、「GitHub版」から保存済みMarkdownへ移動でき、その場で1件ずつ片付けられる（[ADR 0033](docs/adr/0033-dismiss-clips-from-the-web-page.md)）。件数で切らないので、古い在庫が一覧から落ちない（[ADR 0032](docs/adr/0032-clip-page-shows-the-backlog-not-the-newest.md)）。GitHubへログインできない環境からも眺められる（[ADR 0030](docs/adr/0030-read-only-clip-page-on-the-public-boundary.md)）。
- **保存した本文を、その場で読む**
  一覧の各行の「読む」から、保存済みのMarkdownをそのままページとして読める。英語の記事は保存の後で日本語へ置き換わっているため、**GitHubにログインできない環境でも訳文が読める**。本文はD1へ複製せず、開くたびにGitHubから読む（[ADR 0034](docs/adr/0034-read-the-saved-body-on-the-clip-page.md)）。
- **閲覧ページをホーム画面から開く**
  固有のfaviconとWeb App Manifestを持ち、スマートフォンのホーム画面へ追加したときもReading Clipperのアイコンで見分けられる。アイコンとmanifestも本文と同じAccessの後ろで配り、オフラインキャッシュは持たない（[ADR 0035](docs/adr/0035-icons-and-installable-clip-page.md)）。
- **片付けたクリップは、その下に1行ずつ全件**
  読み終えた記事のURLを後から取りに来るための面。サムネイルと抜粋は出さず、題名・保存日・ホスト・「GitHub版」だけを1行で並べる。スクリプトを持たない1枚のページなので、全件があればブラウザの検索でそのまま引ける。記事のファイル名は日付で長くせずタイトルのまま保つ。
- **保存済みクリップを本文から探して読み返す**
  Slackで覚えている語を伝えると、GitHub上の本文から最大5件の候補を探し、選んだMarkdownだけを読んで質問へ答える。D1に記録が無いクリップも検索でき、削除済みの古い検索結果は本文を読む直前の実在確認で止める。本文検索はGitHubのコード検索索引に依存するため、0件でも「保存されていない」ことの根拠にはしない。
- **題名を言えるクリップは、索引の状態によらず必ず見つける**
  題名の一部を伝えると、コード検索索引ではなくGitHubのファイル一覧そのものを走査して在否を答える。全件を見た結果なので、0件は「保存されていない」という事実として扱える。実際にコード検索索引が5日以上巻き戻り、39件中22件が題名でも引けなくなった事故を受けた判断（[ADR 0031](docs/adr/0031-list-clips-from-the-file-tree.md)）。
- **その場で、Webの一覧から、または週次ダイジェストで片付け**
  保存した直後の返信とWebの未片付けカードにボタンが付き、読まないと決めた記事をその場で片付けられる。まだ片付けていないクリップは毎週日曜9時（JST）に最大7件Slackへ再掲され、こちらもボタンまたはスレッド内の自然文で片付けられる。GitHub上でMarkdownを直接消したクリップは、投稿の直前に実在を確かめて落とすため、ダイジェストには出てこない。
- **壊れた保存はチャットから削除**
  本文が取れず概要だけが保存されてしまった記事は、Slackで題名やURLの一部を挙げれば消せる。AIが保存済みのクリップを検索して対象を特定し、GitHubのファイルと記録の両方を消す。

## 主な特徴・設計上のポイント

### 操作はSlackを中心に、在庫の片付けはWebからも

保存、要約、記事についての会話、週次通知、片付けまでをSlackで完結できる。新しい操作画面を覚える必要がない。

Webの一覧では、眺めながら判断したクリップをそのカードから片付けられる。保存や会話などの入口は増やさず、Webの操作は単体の片付けだけに限る（[ADR 0033](docs/adr/0033-dismiss-clips-from-the-web-page.md)）。

### Cloudflare Workersによる軽快な応答

常駐サーバーを持たず、Cloudflare Workers、Queues、Durable Objects、D1を組み合わせている。Workersの短いコールドスタートを活かし、個人利用では無料枠を中心にしながら体感速度を損なわない構成を狙っている。

Slack Events APIへの応答は受付処理だけに限定し、本文取得、AI処理、GitHub保存はQueueへ渡す。時間のかかる処理からSlackの3秒制限を切り離している。

### 用途ごとに状態の置き場所を分離

- 記事本文の正本はprivate GitHubリポジトリに置く
- Slackスレッドごとの会話履歴はDurable Objectsに置く
- 週次ダイジェストの「片付けたか」と表示履歴はD1に置く

D1は厳密な既読・未読管理ではなく、GitHub上のクリップへ付ける軽量な注釈レイヤー。失われてもGitHubのMarkdownから再構成できる。

## システム構成

上の構成図はBot/Core Workerの内部を示す。矢印は主要な連携を表し、完全なリクエスト・レスポンスの時系列ではない。MCP公開境界は下で別に説明する。

Slack受付、Queue処理、週次cronはBot/Core Workerへ同居させ、公開MCP境界だけをMCP Edge Workerへ分離している。AI Gateway経由でGeminiを呼び、記事本文はGitHub、会話履歴とtool refはDurable Objects、ダイジェスト用の状態はD1へ保存する。

構成図の編集元とアイコンの出典は[`docs/architecture/`](docs/architecture/)にある。

### 公開境界

現在のWorkerをBot/Coreとして残し、外部から到達する入口だけを持つMCP Edge Workerを同じrepositoryから別deployする。外部MCP clientはCloudflare Access Managed OAuthで保護したCustom Domainへ接続し、MCP EdgeからCoreへはDNSを通さずService Binding RPCで到達する。通常Botは公開MCPを経由せず、両方の入口が同じCore use caseを呼ぶ。

`load_content` / `save_loaded`と`list_clips` / `find_clips` / `read_clip` / `delete_clip`の受け渡しは、owner単位のDurable Objectに置くopaque refを使う。通常BotとMCPで同じtool contractを共有し、会話履歴とrefは90日で削除する。MCP tool callは同期で処理し、既存QueueはSlackの3秒ACKと再試行のためだけに残す。詳細と判断理由は[ADR 0021](docs/adr/0021-publish-tools-through-mcp-edge.md)と[ADR 0022](docs/adr/0022-persist-tool-refs-in-durable-object.md)に記録している。

MCP Edgeは`wrangler.mcp.jsonc`で管理する。Coreを先にdeployした後、EdgeへCustom Domainを手動設定し、そのhostname全体をAccess applicationで保護してManaged OAuthを有効にする。EdgeはCloudflareが検証済みの`ctx.access`からaudienceと本人identityを確認する。必要な実環境値は`ACCESS_AUD`、`ACCESS_ALLOWED_EMAIL`、`MCP_HOSTNAME`で、Coreの業務secretは渡さない。`workers.dev`とpreview URLは無効化している。

このWorkerは`/mcp`のほかに、クリップの閲覧ページ`/clips`と、保存した本文を読む`/clips/read`を持つ。同じCustom Domain、同じAccess applicationの後ろに置き、認証は共通。EdgeはAccessで確認した本人であることだけを確かめてCoreへRPCを投げ、HTMLの組み立てはCore側で行う。Edgeにクリップのデータもsecretも持たせない（[ADR 0030](docs/adr/0030-read-only-clip-page-on-the-public-boundary.md)）。ページはブラウザから開くだけなのでManaged OAuthは経由しない。

`ACCESS_AUD`にはAccess applicationのaudience tag、`ACCESS_ALLOWED_EMAIL`には許可する本人のemail、`MCP_HOSTNAME`にはschemeを含まないCustom Domainのhostnameを設定する。Custom Domain、Access application / policy / Managed OAuth、MCP Edge用のWorkers Builds接続は実環境で手動設定する。

## 技術スタック

| 分類 | 技術 | 役割 |
| --- | --- | --- |
| 言語 | TypeScript | Worker、取得処理、GitHub連携 |
| HTTP / MCP | slack-edge / MCP TypeScript SDK | Slack Events API、Interactivity、Streamable HTTP |
| 実行基盤 | Cloudflare Workers | HTTP受付、Queue consumer、scheduled handler |
| 非同期処理 | Cloudflare Queues | Slack受付と本文取得・AI処理を分離、保存後の翻訳を分離 |
| 会話・tool状態 | Cloudflare Durable Objects | Slackスレッド単位の会話履歴、owner単位のopaque ref、90日Alarm cleanup |
| ダイジェスト状態 | Cloudflare D1 / Cron Triggers | 片付け状態、再掲履歴、週次実行 |
| AI | Vercel AI SDK / Gemini / Cloudflare AI Gateway | 要約、質問応答、保存対象の判断、保存後の翻訳 |
| 表示 | marked | 保存したMarkdownを閲覧ページのHTMLへ |
| 本文取得 | Qiita Markdown / Zenn API / X API / arXiv LaTeXML HTML / Speaker Deck・ドクセルの構造化データ / Firecrawl | URLごとの本文取得 |
| 保存 | GitHub App / Contents API | privateリポジトリへのMarkdown保存 |
| テスト | Vitest / Cloudflare Workers test pool | Worker環境でのユニットテスト |

## セットアップ

### 前提

- Node.js 22
- `package.json`で固定されたpnpm
- Socket Firewall（依存関係の取得時に使用）
- Cloudflare、Slack App、GitHub App、Gemini API、Firecrawl、X APIの各アカウント

### ローカル開発

```powershell
sfw pnpm install
pnpm wrangler d1 execute reading-clipper-clips-db --local --file=./schema.sql
pnpm dev
```

Slack連携を含めて動かすには、`wrangler.jsonc`に定義されたQueue、Durable Objects、D1、Cron Triggers、AI Gatewayと、次のWorker Secretsが必要。最新の一覧と用途は[`src/types.ts`](src/types.ts)の`Env`を参照。

```text
CLOUDFLARE_ACCOUNT_ID
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
SLACK_ALLOWED_TEAM_ID
SLACK_ALLOWED_USER_ID
AI_GATEWAY_TOKEN
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_INSTALLATION_ID
GITHUB_REPO
FIRECRAWL_API_KEY
X_BEARER_TOKEN
```

Secretは個別に登録。

```powershell
pnpm wrangler secret put <NAME>
```

AI Gatewayの作成・更新には、`AI Gateway Read`と`AI Gateway Write`権限を持つCloudflare API tokenを環境変数へ設定し、次を実行。

```powershell
pnpm setup:aigw
```

Slack AppはDMの`message.im`をEvents APIで受信し、Interactivityで片付けのボタンを処理する。Request URLは両方とも`/slack/events`（[ADR 0014](docs/adr/0014-slack-edge-for-the-boundary.md)）。GitHub Appには保存先リポジトリだけを対象とした`Contents: Read and write`権限を与える。

### 検証

```powershell
pnpm test
pnpm typecheck
pnpm dry-run
```

## 制約

- 単一のSlackワークスペースとユーザーをallowlistで許可する個人利用向け。
- XはAPIから取得できる公開Postだけを対象とし、protected contentは保存しない。
- 週次ダイジェストは「読んだか」ではなく「片付けたか」だけを管理。
- 保存先はprivate GitHubリポジトリを前提とし、取得した本文を外部へ再配布しない。閲覧ページもCloudflare Accessで本人だけに限定し、公開しない。
- 閲覧ページの操作は、未片付けカードを1件ずつ片付けることだけ。件数で切らないため、保存が増えるとページも伸びる。
- 本文を読むページは、開くたびにGitHubから取る。GitHubが応答しなければ読めない。
- `clips/README.md`は自動生成しない。GitHub上のクリップ一覧は名前順のファイル一覧だけで、新着や片付けの状態は閲覧ページで見る。
- 削除は既定ブランチの先頭からファイルを消すだけで、本文はGitの履歴に残る。取り消しは`git revert`で行う。
- 翻訳は保存済みの本文を訳文で置き換える形で行い、原文はGitの履歴にだけ残る。訳し漏れたクリップは元の言語のまま残り、訳し直す導線は「同じURLをもう一度送る」だけ。

## 設計判断

主要な設計判断と代替案は[`docs/adr/`](docs/adr/)に記録。

- [Slackの入力をすべてAIへ渡し、保存をツールにする](docs/adr/0006-agent-with-save-tool.md)
- [スレッドの会話履歴をDurable Objectsに保存する](docs/adr/0007-thread-history-in-durable-object.md)
- [週次ダイジェストと片付け状態をD1で管理する](docs/adr/0010-weekly-digest-and-dismiss-bit.md)
- [本文を読んでからAIが保存対象を決める](docs/adr/0012-load-content-then-save-loaded.md)
- [クリップ直後の返信にDismissボタンを出す](docs/adr/0015-dismiss-button-on-the-clip-reply.md)
- [クリップの削除を検索とターン内の参照番号で組む](docs/adr/0016-delete-clip-via-search-and-turn-scoped-ref.md)
- [フラットな保存構造と新着順の表示を分離する](docs/adr/0017-generated-recent-clip-index.md)
- [GitHubから消えたクリップは出す直前の実在確認で落とす](docs/adr/0018-verify-clip-exists-before-digest.md)
- [保存済みクリップはGitHubで検索し、現在の本文を読み直す](docs/adr/0020-search-and-read-saved-clips-via-github.md)
- [MCP公開境界を専用Workerへ分離し、Access Managed OAuthで保護する](docs/adr/0021-publish-tools-through-mcp-edge.md)
- [ツール参照をDurable Objectへ90日保持し、BotとMCPで共通化する](docs/adr/0022-persist-tool-refs-in-durable-object.md)
- [新着一覧をカードと箇条書きに分け、片付けを表示に出す](docs/adr/0023-clip-index-cards-and-dismissed-marks.md)
- [本文の上限は取得と読み直しで1つにし、保存時の素性を読み直しにも渡す](docs/adr/0026-one-body-limit-for-fetch-and-reread.md)
- [日本語でないクリップは、保存の後で本文を日本語へ置き換える](docs/adr/0027-translate-clips-into-japanese-after-saving.md)
- [新着一覧を、公開境界Workerの読み取り専用ページとしても出す](docs/adr/0030-read-only-clip-page-on-the-public-boundary.md)
- [題名での在否確認は、二次索引ではなくファイル一覧で行う](docs/adr/0031-list-clips-from-the-file-tree.md)
- [新着一覧をやめ、閲覧ページを在庫の面にする](docs/adr/0032-clip-page-shows-the-backlog-not-the-newest.md)
- [閲覧ページのカードからクリップを片付ける](docs/adr/0033-dismiss-clips-from-the-web-page.md)
- [保存した本文を、閲覧ページで読めるようにする](docs/adr/0034-read-the-saved-body-on-the-clip-page.md)
- [閲覧ページへアイコンとWeb App Manifestを置く](docs/adr/0035-icons-and-installable-clip-page.md)
