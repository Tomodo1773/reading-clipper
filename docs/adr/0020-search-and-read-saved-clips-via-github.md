# ADR 0020: 保存済みクリップはGitHubで検索し、現在の本文を読み直す

- ステータス: Accepted
- 日付: 2026-08-23

> 更新: GitHubを検索・読取の正本にする判断は維持する。`read_clip`が受けるrefの保持範囲は[ADR 0022](0022-persist-tool-refs-in-durable-object.md)で変更し、ターンを越えて90日使えるopaque refにする。
>
> 更新: `read_clip`の1回60,000文字という上限と、返り値の`complete`は[ADR 0026](0026-one-body-limit-for-fetch-and-reread.md)で変更する。上限は取得時と同じ200,000文字に統一し、フロントマターを捨てずに保存時の素性も返す。

## 背景

`find_clips`はD1の`title` / `url` / `path`だけを部分一致で探していた。本文はGitHubにしかなく、保存したスレッドを離れると、本文にしか出ない語から記事を探すことも、見つけた記事を読み返すこともできない。

D1へ本文を複製して検索する案を検討したが、GitHubとD1の母集団は常には一致しない。

- GitHubへの保存に成功してD1への記録に失敗すると、検索から永久に抜ける。
- GitHub上で直接消したファイルの行がD1へ残ると、存在しないクリップが検索に当たる。
- [ADR 0018](0018-verify-clip-exists-before-digest.md)の実在確認は、ダイジェスト候補だけを守る。検索対象の全行は守らない。

全文検索をD1へ置くなら、GitHubからD1への継続的な突き合わせも検索機能の一部になる。検索のためだけに正本の母集団を複製し、同期経路まで持つ形である。

一方、GitHub REST APIの`GET /search/code`はGitHub App installation access tokenに対応している。実際の保存先リポジトリでは、private repository内の日本語本文と途中部分が検索でき、text-match metadataから一致箇所を取得できることを確認した。さらにGitHub Actionsの`GITHUB_TOKEN`がinstallation tokenであることを同じリクエスト内で確認し、そのトークンでAPI version `2022-11-28`のCode Searchが成功するスモークテストも行った。

- [Search code](https://docs.github.com/en/rest/search/search#search-code)
- [Endpoints available for GitHub App installation access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens)
- [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- [Installation-token smoke run](https://github.com/Tomodo1773/reading-clipper/actions/runs/32628757264)

## 決定

### GitHubを検索の母集団にする

- `find_clips(query)`はGitHub Code Search APIを使う。D1で本文を検索しない。
- 検索クエリへ`repo:{GITHUB_REPO}` / `path:clips/` / `extension:md` / `in:file,path`を必ず足す。
- APIの結果も、設定したリポジトリ・`clips/`配下・Markdownという条件で再び絞る。検索語に別のqualifierが混じっても、対象外の結果をモデルへ渡さない。
- GitHubが`incomplete_results: true`を返したときは検索失敗として扱う。空配列へ落として「見つからなかった」とは言わない。
- Code Searchの上位5件だけを候補として返す。続きが要るときは検索語を絞って探し直し、ページ送りや候補の補充は持たない。
- 検索時には候補の本文を取得しない。ファイル名から題名を示し、GitHubが返した一致箇所を候補選びのsnippetとして使う。
- 自動生成した`clips/README.md`は保存先パスで候補から外す。

これにより、GitHubにあってD1に無いクリップも検索でき、D1にだけ残った孤児行は検索へ影響しない。

### D1は検索結果への注釈だけを担う

- GitHubで見つけた候補のパスをD1へ問い合わせ、`dismissed_at`など既存の値を結果へ足す。
- D1に行が無ければ`dismissed: null`とし、「注釈なし」と「片付けていない」を区別する。Code Searchの候補自体はD1に無くても落とさない。
- D1の問い合わせに失敗しても、GitHubの検索結果は返す。
- D1へ`body`列、検索索引、GitHub blob SHAを追加しない。スキーマ変更とバックフィルは発生しない。

### 本文はGitHubから読む

- `read_clip(ref)`を追加し、`find_clips`がそのターンで返した候補1件だけをContents APIから読む。
- フロントマターを除いた本文だけを返す。題名と出典URLも、同じファイルのフロントマターから取る。
- `find_clips`のsnippetは対象を見分ける手掛かりに限定し、記事について答える根拠にはしない。
- Code Searchの索引が削除へ追いついておらずContents APIが404を返したら、`missing`として次の候補を試す。検索時に全候補を先読みして埋めない。
- 読み出した本文は会話履歴へ残るため、1回60,000文字を上限にする。超えたときは`complete: false`を返す。
- `read_clip`も[ADR 0016](0016-delete-clip-via-search-and-turn-scoped-ref.md)と同じターン内refを受け取る。検索候補を選ぶだけなので、モデルがパスを組み立てる必要はない。

## 検討した代替案

- **D1へ本文を複製し、`LIKE`で検索する**: 日本語の途中部分も検索できる。採らない理由は、検索結果の完全性がGitHubとD1の同期へ依存するため。D1にはLIKE patternが50 bytesまでという制約もある。
- **D1へFTS5 trigram索引を作る**: 件数が増えたときの検索性能は高い。採らない理由は本文と母集団の同期問題が変わらず、索引・trigger・migration・復旧手順まで増えるため。
- **Trees APIでGitHubとD1を定期同期してからD1を検索する**: D1を派生索引として収束させられる。採らない理由は、Code Searchなら検索の母集団を最初からGitHubに置けるため。ダイジェストと新着一覧に残るD1不整合は別の問題として扱う。
- **GitHubから全Markdownを毎回取得してWorker内で検索する**: 外部の検索索引に依存しないが、1回の検索が全件取得になり、件数に比例して遅くなる。

## 影響

- GitHubにだけ存在するクリップも、本文から検索して読み返せる。
- Code Searchの索引から削除が遅れた候補は一時的に現れるが、選んだ候補を`read_clip`で開く時点で404を検出し、本文を読めたことにはしない。
- Code Searchはdefault branchだけを対象とし、384KB以上のファイルを検索しない。保存直後は索引へ反映されるまで見つからないこともある。同じスレッドには`load_content`の本文が残るため、保存直後の質問は検索を必要としない。
- Code Searchは1分10リクエストである。1回の`find_clips`は1リクエストなので、単一利用者のDMでは許容する。403や429は成功・0件扱いにしない。
- 題名や本文の検索順位はGitHubに委ねる。ツールがモデルへ返す候補は最大5件である。
- ダイジェストと`clips/README.md`がD1を使うことは変わらない。検索をGitHubへ移しても、両者の不整合問題が解消したことにはしない。
