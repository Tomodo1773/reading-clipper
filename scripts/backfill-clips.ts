/**
 * 既存クリップをD1の台帳へ流し込むSQLを作る（ADR 0010）。
 *
 * D1はGitHubに対する注釈レイヤーなので、母集団はいつでもGitHubから作り直せる。
 * 初回のバックフィルと、D1を失ったあとの復旧の両方でこれを使う。
 * 失われたまま戻らないのは、Dismissと提示の記録だけである。
 *
 * 実行:
 *   gh api "repos/<owner>/<repo>/git/trees/main?recursive=1" \
 *     --jq '.tree[] | select(.type == "blob") | .path' \
 *     | node --experimental-strip-types scripts/backfill-clips.ts > backfill.sql
 *   pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=backfill.sql
 *
 * `clipped_at`には実行時刻を、`url`にはNULLを入れる。フロントマターは読まない。
 * 既にある行は触らないので、何度実行しても片付けた印は消えない。
 */

/** SQLの文字列リテラル。クリップのパスは記事タイトルそのままで、アポストロフィを含みうる。 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

const paths = (await readStdin())
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('clips/') && line.endsWith('.md'));

if (paths.length === 0) {
  console.error('clips/ 配下の .md パスが1件も渡されていない。');
  process.exit(1);
}

const clippedAt = new Date().toISOString();
const statements = paths.map(
  (path) =>
    `INSERT INTO clips (path, url, clipped_at) VALUES (${sqlLiteral(path)}, NULL, ${sqlLiteral(clippedAt)}) ON CONFLICT(path) DO NOTHING;`,
);

process.stdout.write(`${statements.join('\n')}\n`);
console.error(`${paths.length}件ぶんのINSERTを書き出した。`);
