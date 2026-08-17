-- 読書状態の正本（ADR 0010）。
--
-- このテーブルはクリップの台帳ではなく、GitHubに対する注釈レイヤーである。
-- 本文・タイトル・ホストの正本はGitHubにあり、失われても母集団は
-- Trees APIから再構成できる（scripts/backfill-clips.ts）。
--
-- 適用（wrangler migrationsは使わない。README「インフラ管理とデプロイ」を参照）:
--   pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=./schema.sql
--   pnpm wrangler d1 execute reading-clipper-clips-db --local  --file=./schema.sql

CREATE TABLE IF NOT EXISTS clips (
  -- clips/{host}/{title}.md。タイトルはここから取れるので列に持たない。
  path          TEXT PRIMARY KEY,
  -- 記事のcanonical URL。バックフィルで入れた行はNULLで、GitHubのファイルへリンクする。
  url           TEXT,
  clipped_at    TEXT NOT NULL,
  -- 週次ダイジェストに出した時刻。NULLは未提示で、SQLiteの ASC が先頭へ置く。
  last_shown_at TEXT,
  -- 「片付けた」印。これ以外に読書状態を持たない。
  dismissed_at  TEXT
);
