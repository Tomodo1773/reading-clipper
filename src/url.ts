import { ClipError } from './errors';
import type { ClipSource } from './types';

export function canonicalizeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ClipError('invalid URL', 'validation', false);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ClipError('only public HTTP(S) URLs are supported', 'validation', false);
  }

  url.hostname = url.hostname.toLowerCase();
  url.hash = '';

  if (['twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'www.x.com'].includes(url.hostname)) {
    url.hostname = 'x.com';
  }
  if (url.hostname === 'www.qiita.com') url.hostname = 'qiita.com';
  if (url.hostname === 'www.zenn.dev') url.hostname = 'zenn.dev';
  if (url.hostname === 'www.arxiv.org') url.hostname = 'arxiv.org';
  if (url.hostname === 'www.speakerdeck.com') url.hostname = 'speakerdeck.com';
  // ドクセルは`www`無しでも200を返すが、自身は`og:url`と構造化データで`www`付きを名乗る。
  if (url.hostname === 'docswell.com') url.hostname = 'www.docswell.com';

  const source = classifyUrl(url);
  if (source !== 'web') {
    url.protocol = 'https:';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
  }
  if (source === 'qiita' || source === 'zenn') url.pathname = url.pathname.replace(/\.md$/i, '');
  if (source === 'x') url.pathname = `/i/web/status/${extractXPostId(url)}`;
  // `abs`が論文の識別で、`html`と`pdf`はその表現。版を落とすのはarXiv自身の宣言に従う
  // （`/abs/{id}v1`のページが`link rel="canonical"`で版無しのURLを指す。ADR 0024）。
  if (source === 'arxiv') url.pathname = `/abs/${extractArxivId(url)}`;
  return url;
}

export function classifyUrl(url: URL): ClipSource {
  if (url.hostname === 'qiita.com' && /^\/[^/]+\/items\/[^/]+(?:\.md)?\/?$/.test(url.pathname)) {
    return 'qiita';
  }
  // 本（/books/）やスクラップ（/scraps/）は記事と構造が違うため、記事だけを対象にする。
  if (url.hostname === 'zenn.dev' && extractZennArticleSlug(url)) return 'zenn';
  if (url.hostname === 'x.com' && extractXPostId(url)) return 'x';
  if (extractArxivId(url)) return 'arxiv';
  if (url.hostname === 'speakerdeck.com' && isSpeakerdeckTalk(url)) return 'speakerdeck';
  if (url.hostname === 'www.docswell.com' && DOCSWELL_SLIDE.test(url.pathname)) return 'docswell';
  return 'web';
}

/**
 * 発表ページと同じ`/{1}/{2}`の形をした、Speaker Deck自身のページの先頭要素。
 * カテゴリ（`/c/technology`）、特集（`/p/featured`・`/s/featured`）、機能紹介
 * （`/features/...`・`/pro/...`）、埋め込みプレイヤー（`/player/{hash}`）が該当する。
 * ユーザー名にこれらは使えないため、除外しても発表ページを取りこぼさない。
 */
const SPEAKERDECK_RESERVED = new Set(['c', 'p', 's', 'features', 'pro', 'player']);

/** `speakerdeck.com/{ユーザー}/{発表}`。ユーザーのページ（1要素）は発表ではない。 */
function isSpeakerdeckTalk(url: URL): boolean {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return false;
  return !SPEAKERDECK_RESERVED.has(segments[0] ?? '');
}

/** `www.docswell.com/s/{ユーザー}/{キー}-{スラッグ}`。 */
const DOCSWELL_SLIDE = /^\/s\/[^/]+\/[^/]+\/?$/;

/** 新形式（`2608.18300`）。 */
const ARXIV_NEW_ID = /^\d{4}\.\d{4,5}$/;
/** 旧形式（`hep-th/9108001`、`math.AG/0611234`）。パスにスラッシュを含む。 */
const ARXIV_OLD_ID = /^[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7}$/;

/**
 * `arxiv.org/{abs|html|pdf}/{id}`のIDを、版の接尾辞を落として返す。
 * 版を含めないのは、arXiv自身が版を別資源ではなく同一資源の版として扱うため（ADR 0024）。
 */
export function extractArxivId(url: URL): string | undefined {
  if (url.hostname !== 'arxiv.org') return undefined;
  const path = url.pathname.replace(/\/$/, '').match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?$/i);
  const id = path?.[1]?.replace(/v\d+$/i, '');
  if (!id) return undefined;
  return ARXIV_NEW_ID.test(id) || ARXIV_OLD_ID.test(id) ? id : undefined;
}

/** `zenn.dev/{user|publication}/articles/{slug}` のslugを返す。 */
export function extractZennArticleSlug(url: URL): string | undefined {
  const match = url.pathname.match(/^\/[^/]+\/articles\/([^/]+?)(?:\.md)?\/?$/i);
  return match?.[1];
}

export function extractXPostId(url: URL): string | undefined {
  const match = url.pathname.match(/\/(?:i\/web\/)?status\/(\d+)/);
  return match?.[1];
}

/** Windowsが禁じる文字と制御文字。日本語や記号はここに含まれないため残す。 */
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
/** Windowsの予約デバイス名。拡張子が付いていても予約されたままになる。 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
/** 多くのファイルシステムとGitで、パス構成要素1つの上限は255バイト。 */
const MAX_FILE_NAME_BYTES = 255;
const CLIP_EXTENSION = '.md';
const FALLBACK_FILE_NAME = 'untitled';

const utf8 = new TextEncoder();

/** マルチバイト文字やサロゲートペアの途中で切らずに、UTF-8バイト長で切り詰める。 */
function truncateToBytes(value: string, maxBytes: number): string {
  let total = 0;
  let result = '';
  for (const character of value) {
    const size = utf8.encode(character).length;
    if (total + size > maxBytes) break;
    total += size;
    result += character;
  }
  return result;
}

/**
 * 記事タイトルを、そのまま読めるファイル名へ整える。
 * ローマ字化や小文字化はせず、システム上壊れる要素だけを取り除く。
 */
function makeClipFileName(title: string): string {
  let name = title
    .replace(FORBIDDEN_CHARACTERS, ' ')
    // 連続する空白は`-`1つにまとめ、CLIやgitで扱いやすくする。`\s`は全角空白も含む。
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    // 先頭のドットは隠しファイル化し、末尾のドットと空白はWindowsで壊れる。
    .replace(/^[-.\s]+|[-.\s]+$/gu, '');

  const [head = '', ...rest] = name.split('.');
  if (RESERVED_DEVICE_NAME.test(head)) name = [`${head}_`, ...rest].join('.');

  // clips/README.mdはフォルダのREADMEに予約し、記事には使わない（ADR 0017、ADR 0032）。
  if (/^readme$/iu.test(name)) name = `${name}-clip`;

  name = truncateToBytes(name, MAX_FILE_NAME_BYTES - CLIP_EXTENSION.length).replace(
    /[-.\s]+$/gu,
    '',
  );
  return `${name || FALLBACK_FILE_NAME}${CLIP_EXTENSION}`;
}

/** タイトルは取得後にしか分からないため、fetchの結果を受け取って保存先を決める。 */
export function buildClipPath(title: string): string {
  return `clips/${makeClipFileName(title)}`;
}

/**
 * 題名を照合するためのキー。検索語と保存済みファイル名の**両方**へ同じものを掛ける（ADR 0031）。
 *
 * `makeClipFileName`の逆写像ではない。ファイル名は`<>:"/\|?*`を空白へ置換してから`-`へ
 * 畳むので、利用者が本物の題名をそのまま貼ると記号が食い違う。記号をすべて区切りへ落とせば、
 * その差も全角・半角の揺れ（`｜`と`|`）も吸収できる。NFKCだけでは足りない。
 * `〜`(U+301C)と`～`(U+FF5E)はNFKCで統一されず、保存済みのファイル名に前者が現れる。
 */
export function clipNameKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

/**
 * 保存先パスのファイル名が、検索語のすべてを含むか（ADR 0031）。
 * 検索語が空なら真を返す。絞り込み無しの列挙が同じ経路を通る。
 */
export function clipNameMatches(path: string, query: string): boolean {
  const key = clipNameKey((path.split('/').pop() ?? path).replace(/\.md$/iu, ''));
  return clipNameKey(query)
    .split(' ')
    .filter(Boolean)
    .every((term) => key.includes(term));
}
