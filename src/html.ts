/**
 * HTMLの属性と`og:image`を読むための、ごく小さな道具（ADR 0011）。
 *
 * Worker側（保存時の`fetchPageHead`）とNode側（バックフィル）の両方から呼ぶため、
 * このモジュールは何もimportしない。`excerpt.ts`と同じ理由で、片方だけに実装を置くと
 * 同じ値の出どころが2本に割れる。実際、以前はバックフィル側が独自の正規表現で
 * `og:image`を拾っており、二重引用符の属性と5種類の実体参照しか扱えなかった。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

const ATTRIBUTE_PATTERN = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function decodeEntities(value: string): string {
  return value.replace(/&(#[Xx]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (!entity.startsWith('#')) return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

export interface MetaTag {
  /** `property`を優先し、無ければ`name`。小文字にそろえる。 */
  key: string;
  content: string;
}

/**
 * `<meta>`を書かれた順に読む。
 *
 * 辞書ではなく列で返すのは、同じキーが何度も並ぶ場合があるためである（arXivのabsページは
 * `citation_author`を著者の数だけ並べる）。キーか値が空のものはここで落とす。
 */
export function readMetaTags(html: string): MetaTag[] {
  const tags: MetaTag[] = [];
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(tag[0].slice('<meta'.length, -1));
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    const content = attrs.content?.trim();
    if (!key || !content) continue;
    tags.push({ key, content });
  }
  return tags;
}

const OG_IMAGE_KEYS = new Set(['og:image', 'og:image:url', 'og:image:secure_url']);

/**
 * `og:image`を絶対URLとして返す。相対パスで書くサイトがあるため`pageUrl`で解決する。
 * Slackへ渡せるのはhttp(s)の絶対URLだけなので、`data:`などはここで落とす。
 *
 * どこまでのHTMLを渡すかは呼び出し側が決める。Worker側は`</head>`で打ち切った分だけを渡す。
 */
export function findOgImage(html: string, pageUrl: string): string | undefined {
  const tag = readMetaTags(html).find((meta) => OG_IMAGE_KEYS.has(meta.key));
  if (!tag) return undefined;
  const resolved = new URL(tag.content, pageUrl);
  return resolved.protocol === 'https:' || resolved.protocol === 'http:'
    ? resolved.toString()
    : undefined;
}
