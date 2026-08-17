/**
 * 既存クリップをD1の台帳へ流し込むSQLを作る（ADR 0010、ADR 0011）。
 *
 * D1はGitHubに対する注釈レイヤーなので、母集団はいつでもGitHubから作り直せる。
 * 初回のバックフィルと、D1を失ったあとの復旧の両方でこれを使う。
 * 失われたまま戻らないのは、Dismissと提示の記録だけである。
 *
 * 実行:
 *   git clone --depth 1 https://github.com/<owner>/<repo>.git /tmp/clips
 *   node --experimental-strip-types scripts/backfill-clips.ts /tmp/clips > backfill.sql
 *   pnpm wrangler d1 execute reading-clipper-clips-db --remote --file=backfill.sql
 *
 * cloneしたリポジトリからフロントマターを読む（ADR 0011）。ADR 0010は当初これを
 * 「O(N)リクエストになる」として避けたが、cloneすればGitHubへのリクエストは1回で済む。
 * `image_url`が無い記事だけは、og:imageを取りに記事数ぶんの外部リクエストが出る。
 * 手元で1回だけ走らせるスクリプトなので、そこは許容する。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { clipExcerpt } from '../src/excerpt.ts';

/** og:imageの取得を同時に何本走らせるか。相手のサイトを叩きすぎない範囲にする。 */
const IMAGE_CONCURRENCY = 4;

const OG_IMAGE_USER_AGENT = 'Mozilla/5.0 (compatible; reading-clipper/1.0)';

interface Clip {
  path: string;
  url: string | undefined;
  title: string | undefined;
  excerpt: string;
  imageUrl: string | undefined;
  clippedAt: string;
}

/** SQLの文字列リテラル。クリップのパスは記事タイトルそのままで、アポストロフィを含みうる。 */
function sqlLiteral(value: string | undefined): string {
  return value === undefined ? 'NULL' : `'${value.replace(/'/g, "''")}'`;
}

/**
 * 先頭のフロントマターだけを読む。
 *
 * Qiitaのクリップは本文自体がもう1つの`---`ブロックで始まるため、
 * 最初のブロックで打ち切らないと本文側のtitleを拾ってしまう。
 * 旧世代のキー（`slack_event_id` / `summary_status`）は黙って無視する。
 */
function splitFrontMatter(source: string): { fields: Record<string, string>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!field?.[1]) continue;
    const raw = (field[2] ?? '').trim();
    // 値は`renderClipMarkdown`が`JSON.stringify`で書いている。boolは素のまま。
    if (raw.startsWith('"')) {
      try {
        fields[field[1]] = String(JSON.parse(raw));
        continue;
      } catch {
        // 壊れた行は素の値として扱う。
      }
    }
    fields[field[1]] = raw;
  }
  return { fields, body: source.slice(match[0].length) };
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function fetchOgImage(pageUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(pageUrl, {
      headers: { accept: 'text/html', 'user-agent': OG_IMAGE_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    const html = await response.text();
    const head = html.slice(0, html.search(/<\/head\s*>/i) + 1 || html.length);
    for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
      const key = tag[0].match(/(?:property|name)\s*=\s*"([^"]*)"/i)?.[1]?.toLowerCase();
      if (key !== 'og:image' && key !== 'og:image:url' && key !== 'og:image:secure_url') continue;
      const content = tag[0].match(/content\s*=\s*"([^"]*)"/i)?.[1];
      if (!content) continue;
      const resolved = new URL(decodeHtml(content), response.url || pageUrl);
      if (resolved.protocol === 'https:' || resolved.protocol === 'http:') return resolved.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 順番に取り出して数本だけ並走させる。件数が増えても同時接続数は変わらない。 */
async function fillImages(clips: Clip[]): Promise<void> {
  const pending = clips.filter((clip) => !clip.imageUrl && clip.url);
  if (pending.length === 0) return;
  console.error(`${pending.length}件のog:imageを取得する。`);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      const clip = pending[cursor];
      cursor += 1;
      if (!clip?.url) continue;
      clip.imageUrl = await fetchOgImage(clip.url);
      done += 1;
      if (done % 10 === 0) console.error(`  ${done}/${pending.length}`);
    }
  });
  await Promise.all(workers);
  console.error(`og:imageが取れたのは${pending.filter((clip) => clip.imageUrl).length}件。`);
}

const root = process.argv[2];
if (!root) {
  console.error('cloneしたリポジトリのパスを引数で渡してください。');
  console.error('  node --experimental-strip-types scripts/backfill-clips.ts /tmp/clips');
  process.exit(1);
}

const clipsDir = join(root, 'clips');
const files = await markdownFiles(clipsDir).catch(() => {
  console.error(`${clipsDir} が読めません。cloneしたリポジトリのルートを渡してください。`);
  process.exit(1);
});

const clips: Clip[] = [];
for (const file of files) {
  const { fields, body } = splitFrontMatter(await readFile(file, 'utf8'));
  clips.push({
    // D1のキーはリポジトリ内のパス。Windowsの`\`はここで`/`へ寄せる。
    path: `clips/${relative(clipsDir, file).split(sep).join('/')}`,
    url: fields.source_url,
    title: fields.title,
    excerpt: clipExcerpt(body),
    imageUrl: fields.image_url,
    clippedAt: fields.clipped_at || new Date().toISOString(),
  });
}

if (clips.length === 0) {
  console.error('clips/ 配下に .md が1件もありません。');
  process.exit(1);
}

await fillImages(clips);

// 既にある行の`dismissed_at`と`last_shown_at`には触れない。表示に使う値は、
// まだ埋まっていないものだけ埋める。`clipped_at`だけは上書きする（ADR 0011）。
// 旧版のバックフィルが実行時刻を入れており、全件が同じ嘘の値になっているため。
const statements = clips.map(
  (clip) =>
    `INSERT INTO clips (path, url, title, excerpt, image_url, clipped_at) VALUES (${sqlLiteral(clip.path)}, ${sqlLiteral(clip.url)}, ${sqlLiteral(clip.title)}, ${sqlLiteral(clip.excerpt)}, ${sqlLiteral(clip.imageUrl)}, ${sqlLiteral(clip.clippedAt)}) ON CONFLICT(path) DO UPDATE SET url = COALESCE(clips.url, excluded.url), title = COALESCE(clips.title, excluded.title), excerpt = COALESCE(clips.excerpt, excluded.excerpt), image_url = COALESCE(clips.image_url, excluded.image_url), clipped_at = excluded.clipped_at;`,
);

process.stdout.write(`${statements.join('\n')}\n`);
console.error(`${clips.length}件ぶんのINSERTを書き出した。`);
