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

  const source = classifyUrl(url);
  if (source !== 'web') {
    url.protocol = 'https:';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
  }
  if (source === 'qiita' || source === 'zenn') url.pathname = url.pathname.replace(/\.md$/i, '');
  if (source === 'x') url.pathname = `/i/web/status/${extractXPostId(url)}`;
  return url;
}

export function classifyUrl(url: URL): ClipSource {
  if (url.hostname === 'qiita.com' && /^\/[^/]+\/items\/[^/]+(?:\.md)?\/?$/.test(url.pathname)) {
    return 'qiita';
  }
  // 本（/books/）やスクラップ（/scraps/）は記事と構造が違うため、記事だけを対象にする。
  if (url.hostname === 'zenn.dev' && extractZennArticleSlug(url)) return 'zenn';
  if (url.hostname === 'x.com' && extractXPostId(url)) return 'x';
  return 'web';
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

  name = truncateToBytes(name, MAX_FILE_NAME_BYTES - CLIP_EXTENSION.length).replace(
    /[-.\s]+$/gu,
    '',
  );
  return `${name || FALLBACK_FILE_NAME}${CLIP_EXTENSION}`;
}

/** タイトルは取得後にしか分からないため、fetchの結果を受け取って保存先を決める。 */
export function buildClipPath(canonicalUrl: string, title: string): string {
  return `clips/${new URL(canonicalUrl).hostname}/${makeClipFileName(title)}`;
}
