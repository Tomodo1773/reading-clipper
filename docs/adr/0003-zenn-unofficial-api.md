# ADR 0003: Zennの記事はZennの非公式APIから取得してMarkdownへ変換する

- ステータス: Accepted
- 日付: 2026-08-15

## 背景

Zennの記事はREADMEの初期方針では「その他のWebページ」に含まれ、Firecrawlで取得していた。しかし実際にクリップすると、目次・カード埋め込み・シンタックスハイライトされたコードブロックなどのページ構造がそのままMarkdownへ落ち、読める形にならなかった。

QiitaはURL末尾に`.md`を付けると公式にMarkdownを返す。Zennにも同じ手段があるかを実際のHTTPレスポンスで確認したが、存在しなかった。

| 試したURL | 結果 |
|---|---|
| `https://zenn.dev/{user}/articles/{slug}.md` | 200だが`text/html`。存在しないパス向けのSPAシェル（`robots: noindex, nofollow`、約31KB）が返るだけで、記事本文もMarkdownも含まない |
| `https://zenn.dev/{user}/articles/{slug}.txt` | 同上。`.md`が特別扱いされていないことの裏付け |
| `https://zenn.dev/{user}/articles/{slug}` に`Accept: text/markdown` | 200 `text/html`。通常の記事ページが返る |
| `https://zenn.dev/{user}/articles/{slug}/md`、`https://zenn.dev/llms.txt` | 404 |
| `https://zenn.dev/api/articles/{slug}/markdown`、`.../body` | 404 |
| `https://zenn.dev/api/articles/{slug}` | 200 `application/json`。記事のメタデータと`body_html`を返す |

記事ページのHTMLと`/api/articles/{slug}`のJSONの双方を検索したが、Markdown原稿を含むフィールドは存在しなかった。RSS（`https://zenn.dev/{user}/feed`）も本文が途中で切られており使えない。

## 決定

Zennの記事（`zenn.dev/{user|publication}/articles/{slug}`）は、非公式APIである`https://zenn.dev/api/articles/{slug}`から取得する。

- タイトル、著者、公開日は同APIのJSONから埋める。
- 本文は`body_html`をアプリ内でMarkdownへ変換する。`body_html`はZenn公式の`zenn-markdown-html`が生成した意味づけの残るHTMLで、見出し、表、リスト、コードブロック、`:::message`（`aside.msg`）、`:::details`、KaTeX（`embed-katex`）が要素として判別できる。ページ全体のHTMLと違い、ナビゲーションや広告のような本文以外の要素を含まない。
- 変換器は依存パッケージを追加せず、この`body_html`が使う要素の範囲に絞って`src/fetchers.ts`に実装する。
- 専用経路が失敗した場合、汎用のFirecrawl経路へはフォールバックせず`ClipError`にする。retryableの判定は既存の`assertOk`に任せる（404などは再試行しない）。

本、スクラップ、ユーザーページはこの経路の対象外で、従来どおり汎用Webとして扱う。

## 検討した代替案

- **Firecrawlのまま使う**: 実際に読めなかったという報告が出発点なので、採用しない。
- **`turndown`のような汎用HTML→Markdown変換ライブラリを追加する**: 変換の質は上がる可能性があるが、DOM実装を伴う依存をWorkerへ持ち込むことになる。対象が`zenn-markdown-html`の出力に限られ、要素の種類が数えられる程度である以上、割に合わない。
- **失敗時にFirecrawlへフォールバックする**: 壊れても動き続ける利点はあるが、非公式APIが壊れたことに気付けなくなる。既存のQiita・Xの取得も専用経路が失敗したらそこで失敗する設計であり、揃える。

## 影響

- 非公式APIのため、Zenn側の変更で予告なく壊れうる。壊れた場合、Zennの記事だけがクリップに失敗し、Slackへ失敗が通知されてdead letter queueへ送られる。取得できなかった内容を取得できたものとして保存しない、というREADMEの完了条件は保たれる。
- `body_html`にはコードブロックの言語が含まれないため、ファイル名が指定されたコードブロック以外は言語の指定が無いフェンスになる。
- KaTeXや脚注のように、元のMarkdown記法へ完全には戻せない部分がある。脚注参照は`[1]`のような本文中の表記になる。
- `zenn-markdown-html`の出力構造が変わると、変換結果の見た目が変わりうる。
