-- 読書状態の正本（ADR 0010）。
--
-- このテーブルはクリップの台帳ではなく、GitHubに対する注釈レイヤーである。
-- 本文・タイトル・ホストの正本はGitHubにあり、失われても母集団は
-- Trees APIから再構成できる（scripts/backfill-clips.ts）。
--
-- 適用（wrangler migrationsは使わない。README「インフラ管理とデプロイ」を参照）:
--   pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=./schema.sql
--   pnpm wrangler d1 execute reading-clipper-clips-db --local  --file=./schema.sql
--
-- このファイルは`CREATE TABLE IF NOT EXISTS`1文だけで構成する。テストが全体を1文として
-- `prepare().run()`へ流すため（test/helpers.ts）、2文目を書くとテストが壊れる。
-- 既にテーブルがあるDBへ列を足すときは、以下を手で1回流す（ADR 0011で追加した3列）:
--   ALTER TABLE clips ADD COLUMN title TEXT;
--   ALTER TABLE clips ADD COLUMN excerpt TEXT;
--   ALTER TABLE clips ADD COLUMN image_url TEXT;

CREATE TABLE IF NOT EXISTS clips (
  -- clips/{title}.md。ホストはここには無く、`url`から取る。
  path          TEXT PRIMARY KEY,
  -- 記事のcanonical URL。NULLの行はGitHubのファイルへリンクする。
  url           TEXT,
  -- 記事タイトル。パス末尾はファイル名として削られるので、ダイジェストはこちらを優先する。
  title         TEXT,
  -- 本文の先頭。ダイジェストでタイトルの下に出す（ADR 0011）。
  excerpt       TEXT,
  -- 記事のog:image。ダイジェストのサムネイルに使う（ADR 0011）。
  image_url     TEXT,
  clipped_at    TEXT NOT NULL,
  -- 週次ダイジェストに出した時刻。NULLは未提示で、SQLiteの ASC が先頭へ置く。
  last_shown_at TEXT,
  -- 「片付けた」印。これ以外に読書状態を持たない。
  dismissed_at  TEXT
);
