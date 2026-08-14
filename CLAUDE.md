# reading-clipper

## 初期構築中

このリポジトリは、あとで読むクリッピングサービスの初期構築中です。
作業を始める前に、必ず [`README.md`](README.md) を読み、そこに書かれた目的・初期バージョンの完了条件・制約を確認してください。README.md は初期構築時の設計書です。

初期構築が完了するまでは、開発速度を優先し、`main` へ直接コミットして push します。初期構築完了後は、branch protection、必須CI、Pull Requestを使う通常の運用へ切り替えます。この例外は初期構築期間だけに限定します。

## リポジトリの前提

- このリポジトリは公開リポジトリです。シークレット、トークン、秘密鍵、実環境固有のドメイン・アカウントID・プロジェクトIDをコミットしないでください。
- Cloudflare、GitHub、Slack、外部APIなどの実値は、環境変数またはGit管理外のローカル設定から渡します。
- README.mdに記載された共通ポリシーと設計上の未決事項を、実装前に確認してください。
- 依存関係の取得・更新は、Socket Firewall（`sfw`）経由で実行します。lockfileを管理し、CIではlockfileを変更しません。

## 指示ファイルの同期

`AGENTS.md` と `CLAUDE.md` はシンボリックリンクではない別ファイルとして管理します。内容は完全に一致させ、片方を変更したらもう片方も同じ内容に更新してください。

同期は `.githooks/pre-commit` と GitHub Actions のCIで検証します。ローカルでは `git config core.hooksPath .githooks` を設定してください。

