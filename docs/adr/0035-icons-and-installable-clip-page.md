# ADR 0035: 閲覧ページへアイコンとWeb App Manifestを置く

- ステータス: Accepted（静的アセットの置き先は[ADR 0036](0036-split-the-clip-page-into-its-own-worker.md)で更新）
- 日付: 2026-09-03

## 背景

閲覧ページはブラウザのタブにも、スマートフォンのホーム画面へ追加したときにも固有の
アイコンを持たない。ページは既に日常的に開く在庫の面なので、汎用のブラウザアイコンの
ままでは見分けにくい。

## 決定

- 記事の紙と、紙の後ろから前へ戻るクリップを組み合わせた印を使う。紙は保存する記事、
  クリップの輪は保存した記事が再び目に戻ることを表す。小さい表示で潰れる文字、記事の
  行、AIや外部サービスの印は入れない。
- 原版はSVGで持ち、濃紺、生成り、コーラルのベタ3色にする。同じ原版からPWA用の
  192px、512pxとApple touch icon用の180px PNGを作る。主要な形はmaskable iconの
  安全域へ収める。
- MCP EdgeへWorkers Static Assetsを追加する。`public/`以下はファイルごとのrouteを持たず、
  hostnameに設定したCloudflare Accessの検証後、Workerを起動せずStatic Assetsから直接配る。
- 一覧と本文が共有するHTMLの`head`からfavicon、Apple touch icon、Web App Manifestを
  参照する。manifestは`/clips`を開始URLとscopeにし、standalone表示を指定する。
- service workerとオフラインキャッシュは置かない。本文は開くたびGitHubから読むという
  ADR 0034の性質を変えず、Accessの後ろにある本文を端末へ別経路で残さない。

## 検討した代替案

- **静的ファイルごとにEdgeのrouteを書く**: ファイルを増減するたび境界コードも変わる。
  Static Assetsのファイル対応に任せれば必要ない。
- **アイコンだけAccessを迂回させる**: 内容は秘密ではないが、Access applicationへ例外を
  増やす。認証済みのページが読むだけなので得るものがない。
- **Static AssetsをWorkerからbinding経由で返す**: Worker独自の認可を画像にも重ねられる。
  ただしhostnameのAccessで既に保護され、静的ファイルに利用者固有の内容もないため、
  Worker呼び出しと境界コードだけが増える。
- **生成画像をそのまま原版にする**: アイデア探索には向くが、微かな陰影と輪郭の揺れが
  faviconで濁る。採用した構図だけを決定的なSVGへ起こす。
- **service workerを置く**: オフライン表示を作れる。ただし現在の目的は識別とホーム画面
  からの起動であり、GitHubやAccessが使えない状態の表示仕様を新たに決める必要がある。

## 影響

- MCP Edgeのdeployに静的アセットが加わる。
- インストール後もAccess認証は変わらず、セッション切れでは再ログインが要る。
- ホーム画面からアプリ風に開けるが、オフラインでは動作しない。
