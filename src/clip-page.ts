import { clipTitle, type PageClip, selectAllClips } from './clips';
import type { Env } from './types';

/** 見出しと`<title>`。 */
const CLIP_PAGE_TITLE = 'Clips';

export interface ClipPageOptions {
  /** `owner/repo`。保存済みMarkdownへの絶対リンクに使う。 */
  repo: string;
}

/**
 * HTMLとして解釈される文字を殺す。
 *
 * このページには後ろにサニタイザがいない。ここが注入への防御そのものである。
 * 抜粋は記事本文から作るのでHTMLが混じることがあり、題名も外から来た文字列である。
 * 属性値は必ず`"`で囲み、URLは`sourceHref`を通すこと。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** 題名は複数行になりうる。1行へ畳んでから使う。 */
function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function sourceHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function clipHost(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** `clipped_at`をJSTの短い日付にする。 */
function clippedDay(clippedAt: string): string {
  const at = new Date(clippedAt);
  if (Number.isNaN(at.getTime())) return '';
  const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

/**
 * 保存済みMarkdownへのリンク。GitHubの外から開くのでリポジトリからの完全なURLが要る。
 * refは`HEAD`にする。既定ブランチ名を設定として持たずに済む。
 */
function savedCopyUrl(repo: string, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/blob/HEAD/${encodedPath}`;
}

/**
 * 題名。URLが無い、または不正な古いデータはリンクにしない（ADR 0017）。
 * 台帳に題名を持たない行はパスから導く（ADR 0011）。
 */
function titleLink(clip: PageClip): string {
  const label = escapeHtml(oneLine(clipTitle(clip)));
  const href = sourceHref(clip.url);
  return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
}

/**
 * 題名の脇に出す素性。2つの節が同じ画面に並ぶので、並びも項目も揃える。
 * 保存済みMarkdownへのリンクだけはHTMLとして組むので、エスケープを通さない。
 */
function metaLine(clip: PageClip, repo: string): string {
  return [clipHost(clip.url), clippedDay(clip.clippedAt)]
    .filter(Boolean)
    .map(escapeHtml)
    .concat(`<a href="${escapeHtml(savedCopyUrl(repo, clip.path))}">GitHub版</a>`)
    .join(' · ');
}

/**
 * 1枚もののCSS。外部のスタイルシートとスクリプトを読まない。
 * 外へ取りに行くのは記事のサムネイルだけで、それが失敗しても枠が残るだけで済む。
 */
const CLIP_PAGE_STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --link:#0969da; --button-hover:#f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --link:#4493f8; --button-hover:#21262d; } }
* { box-sizing: border-box; }
body { margin:0 auto; padding:24px 16px 64px; max-width:720px; background:var(--bg); color:var(--fg);
  font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; line-height:1.6; }
h1 { font-size:1.5rem; margin:0; }
h2 { font-size:1rem; font-weight:600; color:var(--muted); margin:28px 0 4px; }
.clips, .done { list-style:none; margin:0; padding:0; }
.clip { display:flex; gap:12px; padding:16px 0; border-top:1px solid var(--line); }
.clip img { width:120px; height:68px; flex:none; object-fit:cover; border-radius:6px; background:var(--line); }
.text { min-width:0; flex:1; }
.title { font-weight:600; margin:0; }
.excerpt { font-size:.875rem; margin:4px 0 0; }
.clip-footer { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; margin-top:6px; }
.clip .meta { color:var(--muted); font-size:.8125rem; margin:0; }
.dismiss-form { margin-left:auto; }
.dismiss-button { min-height:32px; padding:4px 10px; border:1px solid var(--line); border-radius:6px;
  background:transparent; color:var(--fg); font:inherit; font-size:.8125rem; line-height:1.2; cursor:pointer; }
.dismiss-button:hover { background:var(--button-hover); }
.dismiss-button:focus-visible { outline:2px solid var(--link); outline-offset:2px; }
.done li { padding:8px 0; border-top:1px solid var(--line); }
.done .meta { color:var(--muted); font-size:.8125rem; margin-left:8px; }
a { color:var(--link); text-decoration:none; }
a:hover { text-decoration:underline; }
@media (max-width:480px) { .clip img { width:88px; height:50px; } }
`;

/**
 * まだ片付けていない1件。サムネイルと抜粋を添える。ここは眺めて選ぶ面である。
 */
function pendingRow(clip: PageClip, repo: string): string {
  const image = sourceHref(clip.imageUrl);
  const title = oneLine(clipTitle(clip));
  const body =
    `<div class="text"><p class="title">${titleLink(clip)}</p>` +
    (clip.excerpt ? `<p class="excerpt">${escapeHtml(clip.excerpt)}</p>` : '') +
    `<div class="clip-footer"><p class="meta">${metaLine(clip, repo)}</p>` +
    `<form class="dismiss-form" method="post" action="/clips/dismiss">` +
    `<input type="hidden" name="path" value="${escapeHtml(clip.path)}">` +
    `<button class="dismiss-button" type="submit" aria-label="${escapeHtml(`「${title}」を片付ける`)}">片付ける</button>` +
    `</form></div></div>`;
  // Referrerを送らない。記事のサムネイルは第三者のサーバーから読むので、
  // Accessの後ろにあるホスト名をそのまま渡さない。
  const thumbnail = image
    ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return `<li class="clip">${thumbnail}${body}</li>`;
}

/**
 * 片付けた1件。サムネイルも抜粋も出さず1行にする（ADR 0032）。
 *
 * ここへ来るのは眺めるためではなく、読み終えた記事のURLを取りに来るときである。
 * 1件を軽くしておくことが、件数の上限を持たずに全件を並べるための条件になる。
 */
function doneRow(clip: PageClip, repo: string): string {
  return `<li><span class="title">${titleLink(clip)}</span><span class="meta">${metaLine(clip, repo)}</span></li>`;
}

/**
 * 閲覧ページ全体（ADR 0030、ADR 0032）。
 *
 * まだ片付けていないものを全件、その下に片付けたものを全件並べる。件数で切らない。
 * 件数は節の長さがそのまま答えなので、見出しへ入れて別に数えない。
 * 未片付けのカードからは、単体で片付けられる（ADR 0033）。
 */
export function renderClipPage(clips: PageClip[], options: ClipPageOptions): string {
  const pending = clips.filter((clip) => clip.dismissedAt === null);
  const done = clips.filter((clip) => clip.dismissedAt !== null);

  const sections: string[] = [];
  if (clips.length === 0) {
    sections.push('<p>まだクリップはない。</p>');
  } else {
    sections.push(`<h2>まだ片付けていない（${pending.length}件）</h2>`);
    sections.push(
      pending.length === 0
        ? '<p>全部片付いた。</p>'
        : `<ol class="clips">${pending.map((clip) => pendingRow(clip, options.repo)).join('')}</ol>`,
    );
    // 片付けたものが1件も無いうちは、節そのものを出さない。
    if (done.length > 0) {
      sections.push(`<h2>片付けたもの（${done.length}件）</h2>`);
      sections.push(
        `<ol class="done">${done.map((clip) => doneRow(clip, options.repo)).join('')}</ol>`,
      );
    }
  }

  return (
    '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    // Accessの後ろにあるのでクローラーは辿り着かない。公開範囲を変えたときのために置く。
    '<meta name="robots" content="noindex">\n' +
    `<title>${CLIP_PAGE_TITLE}</title>\n<style>${CLIP_PAGE_STYLE}</style>\n</head>\n<body>\n` +
    `<h1>${CLIP_PAGE_TITLE}</h1>\n` +
    `${sections.join('\n')}\n</body>\n</html>\n`
  );
}

/** 閲覧ページのHTMLを組み立てる（ADR 0030）。読むのはD1の1クエリだけ。 */
export async function buildClipPage(env: Env): Promise<string> {
  return renderClipPage(await selectAllClips(env), { repo: env.GITHUB_REPO });
}
