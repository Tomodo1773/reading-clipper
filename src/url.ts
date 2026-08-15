import { ClipError } from './errors';
import type { ClipSource } from './types';
import { sha256Hex } from './utils';

const TRAILING_PUNCTUATION = /[.,!?。、，．！？]+$/u;

export function extractUrls(text: string): string[] {
  const normalized = text.replace(
    /<(https?:\/\/[^>|]+)(?:\|[^>]+)?>/giu,
    (_match, url: string) => ` ${url} `,
  );
  const matches = normalized.match(/https?:\/\/[^\s<>]+/giu) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const candidate = match.replace(TRAILING_PUNCTUATION, '');
    if (!unique.includes(candidate)) unique.push(candidate);
  }
  return unique;
}

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

  const source = classifyUrl(url);
  if (source !== 'web') {
    url.protocol = 'https:';
    url.search = '';
    url.pathname = url.pathname.replace(/\/$/, '');
  }
  if (source === 'qiita') url.pathname = url.pathname.replace(/\.md$/i, '');
  if (source === 'x') url.pathname = `/i/web/status/${extractXPostId(url)}`;
  return url;
}

export function classifyUrl(url: URL): ClipSource {
  if (url.hostname === 'qiita.com' && /^\/[^/]+\/items\/[^/]+(?:\.md)?\/?$/.test(url.pathname)) {
    return 'qiita';
  }
  if (url.hostname === 'x.com' && extractXPostId(url)) return 'x';
  return 'web';
}

export function extractXPostId(url: URL): string | undefined {
  const match = url.pathname.match(/\/(?:i\/web\/)?status\/(\d+)/);
  return match?.[1];
}

function makeSlug(url: URL): string {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 不正なpercent encodingも、URLとしては保存先を決められるようにする。
  }
  const decoded = pathname
    .replace(/\.md$/i, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return (decoded || 'index').slice(0, 80).replace(/-$/g, '') || 'index';
}

export async function buildClipPath(canonicalUrl: string): Promise<string> {
  const url = new URL(canonicalUrl);
  const hash = (await sha256Hex(canonicalUrl)).slice(0, 16);
  return `clips/${url.hostname}/${makeSlug(url)}-${hash}.md`;
}
