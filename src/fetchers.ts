import { ClipError } from './errors';
import type { Env, FetchedContent } from './types';
import { canonicalizeUrl, classifyUrl, extractXPostId, extractZennArticleSlug } from './url';
import { asRecord, assertOk, fetchWithTimeout, stringField } from './utils';

const MAX_CONTENT_CHARS = 200_000;

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function finalize(content: FetchedContent): FetchedContent {
  const normalized = content.markdown.trim();
  if (!normalized) {
    throw new ClipError('fetched content was empty', 'fetch', false);
  }
  if (normalized.length <= MAX_CONTENT_CHARS) {
    return { ...content, markdown: normalized };
  }
  let truncated = normalized.slice(0, MAX_CONTENT_CHARS);
  if (/\p{Surrogate}$/u.test(truncated)) truncated = truncated.slice(0, -1);
  return {
    ...content,
    complete: false,
    markdown: `${truncated.trimEnd()}\n\n> 取得内容は${MAX_CONTENT_CHARS.toLocaleString('en-US')}文字で省略した。`,
  };
}

async function fetchQiita(url: URL): Promise<FetchedContent> {
  const markdownUrl = new URL(url);
  if (!markdownUrl.pathname.endsWith('.md')) markdownUrl.pathname += '.md';
  const response = await fetchWithTimeout(markdownUrl, { headers: { accept: 'text/markdown' } }, 15_000, 'fetch');
  assertOk(response, 'fetch');
  const markdown = await response.text();
  return finalize({
    canonicalUrl: url.toString(),
    source: 'qiita',
    title: firstHeading(markdown) ?? url.pathname.split('/').at(-1) ?? 'Qiita article',
    author: url.pathname.split('/').filter(Boolean)[0],
    markdown,
    complete: true,
  });
}

// Zennは記事のMarkdown原稿を公開していない。取得できるのはzenn-markdown-htmlが生成した
// 意味づけの残るHTMLだけなので、その範囲をMarkdownへ戻す小さな変換器を持つ。
type HtmlNode = string | HtmlElement;

interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'figure', 'figcaption',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul',
]);

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

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

const ATTRIBUTE_PATTERN =
  /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decodeEntities(value: string): string {
  return value.replace(/&(#[Xx]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (!entity.startsWith('#')) return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    const hex = entity[1] === 'x' || entity[1] === 'X';
    const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  let cursor = 0;
  const top = (): HtmlElement => stack[stack.length - 1] ?? root;
  for (const match of html.matchAll(TAG_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) top().children.push(decodeEntities(html.slice(cursor, start)));
    cursor = start + match[0].length;
    const closing = match[1]?.toLowerCase();
    if (closing) {
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]?.tag !== closing) continue;
        stack.length = depth;
        break;
      }
      continue;
    }
    const tag = match[2]?.toLowerCase();
    if (!tag) continue;
    const element: HtmlElement = { tag, attrs: parseAttributes(match[3] ?? ''), children: [] };
    top().children.push(element);
    if (!VOID_TAGS.has(tag) && match[4] !== '/') stack.push(element);
  }
  if (cursor < html.length) top().children.push(decodeEntities(html.slice(cursor)));
  return root.children;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return typeof node !== 'string';
}

function classList(element: HtmlElement): string[] {
  return (element.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

function findDescendant(
  nodes: HtmlNode[],
  predicate: (element: HtmlElement) => boolean,
): HtmlElement | undefined {
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (predicate(node)) return node;
    const nested = findDescendant(node.children, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function collectDescendants(
  nodes: HtmlNode[],
  predicate: (element: HtmlElement) => boolean,
): HtmlElement[] {
  const found: HtmlElement[] = [];
  for (const node of nodes) {
    if (!isElement(node)) continue;
    if (predicate(node)) found.push(node);
    else found.push(...collectDescendants(node.children, predicate));
  }
  return found;
}

function textContent(nodes: HtmlNode[]): string {
  return nodes.map((node) => (isElement(node) ? textContent(node.children) : node)).join('');
}

function codeSpan(value: string): string {
  const text = value.replace(/\r?\n/g, ' ');
  const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function wrapInline(nodes: HtmlNode[], marker: string): string {
  const inner = renderInline(nodes);
  const trimmed = inner.trim();
  if (!trimmed) return inner;
  const leading = inner.slice(0, inner.length - inner.trimStart().length);
  const trailing = inner.slice(inner.trimEnd().length);
  return `${leading}${marker}${trimmed}${marker}${trailing}`;
}

function renderInline(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (!isElement(node)) return node.replace(/\s+/g, ' ');
      switch (node.tag) {
        case 'br':
          return '\n';
        case 'img': {
          const src = node.attrs.src;
          return src ? `![${node.attrs.alt ?? ''}](${src})` : '';
        }
        case 'a': {
          const text = renderInline(node.children).trim();
          const href = node.attrs.href;
          if (!text) return '';
          return href && !href.startsWith('#') ? `[${text}](${href})` : text;
        }
        case 'code':
          return codeSpan(textContent(node.children));
        case 'strong':
        case 'b':
          return wrapInline(node.children, '**');
        case 'em':
        case 'i':
          return wrapInline(node.children, '*');
        case 'del':
        case 's':
        case 'strike':
          return wrapInline(node.children, '~~');
        case 'iframe':
        case 'script':
        case 'style':
        case 'button':
          return '';
        case 'embed-katex': {
          const tex = textContent(node.children).trim();
          if (!tex) return '';
          return node.attrs['display-mode'] ? `$$\n${tex}\n$$` : `$${tex}$`;
        }
        default:
          return renderInline(node.children);
      }
    })
    .join('');
}

/** `<br>` の前後に残るHTML由来の空白を落として、Markdownの改行として読めるようにする。 */
function renderParagraph(nodes: HtmlNode[]): string {
  return renderInline(nodes).replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

function prefixLines(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');
}

function renderCodeBlock(pre: HtmlElement, filename?: string): string {
  const code = textContent(pre.children).replace(/\n+$/, '');
  const fenceLength = (code.match(/^`{3,}/gm) ?? []).reduce(
    (length, run) => Math.max(length, run.length + 1),
    3,
  );
  const fence = '`'.repeat(fenceLength);
  const language = filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
  const header = filename ? `\`${filename}\`\n\n` : '';
  return `${header}${fence}${language}\n${code}\n${fence}`;
}

function renderList(element: HtmlElement, ordered: boolean): string {
  const items = element.children.filter(isElement).filter((child) => child.tag === 'li');
  return items
    .map((item, position) => {
      const marker = ordered ? `${position + 1}. ` : '- ';
      const indent = ' '.repeat(marker.length);
      // 入れ子のリストは段落扱いにせず、親の項目に続けてぶら下げる。
      const body = renderBlocks(item.children).replace(/\n\n(?=(?:- |\d+\. ))/g, '\n');
      const [first = '', ...rest] = body.split('\n');
      return [`${marker}${first}`, ...rest.map((line) => (line ? `${indent}${line}` : ''))].join('\n');
    })
    .join('\n');
}

function renderTable(element: HtmlElement): string {
  const rows = collectDescendants(element.children, (node) => node.tag === 'tr').map((row) =>
    row.children
      .filter(isElement)
      .filter((cell) => cell.tag === 'th' || cell.tag === 'td')
      .map((cell) => renderInline(cell.children).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()),
  );
  const [header, ...body] = rows;
  if (!header?.length) return '';
  const line = (values: string[]): string => `| ${values.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n');
}

function renderBlock(element: HtmlElement): string {
  switch (element.tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const text = renderInline(element.children).replace(/\s+/g, ' ').trim();
      return text ? `${'#'.repeat(Number(element.tag.slice(1)))} ${text}` : '';
    }
    case 'p':
      return renderParagraph(element.children);
    case 'hr':
      return '---';
    case 'pre':
      return renderCodeBlock(element);
    case 'ul':
      return renderList(element, false);
    case 'ol':
      return renderList(element, true);
    case 'table':
      return renderTable(element);
    case 'blockquote':
      return prefixLines(renderBlocks(element.children), '> ');
    case 'aside': {
      // Zennの`:::message`。記号を表す`span.msg-symbol`は捨て、本文だけ引用にする。
      const content = findDescendant(element.children, (node) =>
        classList(node).includes('msg-content'),
      );
      const body = renderBlocks(content?.children ?? element.children);
      return body ? prefixLines(body, '> ') : '';
    }
    case 'details': {
      const summary = element.children.filter(isElement).find((node) => node.tag === 'summary');
      const title = summary ? renderInline(summary.children).trim() : '';
      const body = renderBlocks(element.children.filter((node) => node !== summary));
      return [title ? `**${title}**` : '', body].filter(Boolean).join('\n\n');
    }
    case 'div': {
      if (classList(element).includes('code-block-container')) {
        const pre = findDescendant(element.children, (node) => node.tag === 'pre');
        const filename = findDescendant(element.children, (node) =>
          classList(node).includes('code-block-filename'),
        );
        if (pre) return renderCodeBlock(pre, textContent(filename?.children ?? []).trim() || undefined);
      }
      return renderBlocks(element.children);
    }
    default:
      return renderBlocks(element.children);
  }
}

function renderBlocks(nodes: HtmlNode[]): string {
  const blocks: string[] = [];
  let inline: HtmlNode[] = [];
  const flushInline = (): void => {
    const text = renderParagraph(inline);
    inline = [];
    if (text) blocks.push(text);
  };
  for (const node of nodes) {
    if (!isElement(node) || !BLOCK_TAGS.has(node.tag)) {
      inline.push(node);
      continue;
    }
    flushInline();
    const block = renderBlock(node).trim();
    if (block) blocks.push(block);
  }
  flushInline();
  return blocks.join('\n\n');
}

function zennHtmlToMarkdown(html: string): string {
  return renderBlocks(parseHtml(html)).trim();
}

async function fetchZenn(url: URL): Promise<FetchedContent> {
  const slug = extractZennArticleSlug(url);
  if (!slug) throw new ClipError('Zenn article slug was not found', 'validation', false);
  // 公開されているMarkdown原稿は無く、記事本文を構造付きで取れるのはこの非公式APIだけ。
  const response = await fetchWithTimeout(
    `https://zenn.dev/api/articles/${encodeURIComponent(slug)}`,
    { headers: { accept: 'application/json' } },
    15_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  const article = asRecord(asRecord(await response.json())?.article);
  const bodyHtml = stringField(article, 'body_html');
  if (!bodyHtml) throw new ClipError('Zenn API returned no article body', 'fetch', false);
  const markdown = zennHtmlToMarkdown(bodyHtml);
  const user = asRecord(article?.user);
  return finalize({
    canonicalUrl: url.toString(),
    source: 'zenn',
    title: stringField(article, 'title') ?? firstHeading(markdown) ?? slug,
    author: stringField(user, 'name') ?? stringField(user, 'username'),
    publishedAt: stringField(article, 'published_at'),
    markdown,
    complete: true,
  });
}

function articleBody(article: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['plain_text', 'text', 'body']) {
    const direct = stringField(article, key);
    if (direct) return direct;
  }
  const content = asRecord(article?.content);
  for (const key of ['plain_text', 'text']) {
    const nested = stringField(content, key);
    if (nested) return nested;
  }
  const blocks = article?.blocks ?? content?.blocks;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((block) => stringField(asRecord(block), 'text'))
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    if (text) return text;
  }
  return undefined;
}

async function fetchX(url: URL, env: Env): Promise<FetchedContent> {
  const postId = extractXPostId(url);
  if (!postId) throw new ClipError('X Post ID was not found', 'validation', false);
  const endpoint = new URL(`https://api.x.com/2/tweets/${postId}`);
  endpoint.searchParams.set('tweet.fields', 'article,note_tweet,author_id,created_at');
  endpoint.searchParams.set('expansions', 'author_id');
  endpoint.searchParams.set('user.fields', 'name,username');
  const response = await fetchWithTimeout(
    endpoint,
    { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } },
    15_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  const root = asRecord(await response.json());
  const data = asRecord(root?.data);
  if (!data) throw new ClipError('X API response did not contain a Post', 'fetch', false);

  const article = asRecord(data.article);
  const noteTweet = asRecord(data.note_tweet);
  const body = articleBody(article) ?? stringField(noteTweet, 'text') ?? stringField(data, 'text');
  if (!body) throw new ClipError('X Post body was empty', 'fetch', false);

  const includes = asRecord(root?.includes);
  const users = Array.isArray(includes?.users) ? includes.users : [];
  const authorId = stringField(data, 'author_id');
  const author = users.map(asRecord).find((user) => stringField(user, 'id') === authorId);
  const username = stringField(author, 'username');
  const displayName = stringField(author, 'name');
  const title = stringField(article, 'title') ?? stringField(data, 'article_title') ?? `Post by @${username ?? 'unknown'}`;
  const attribution = [displayName, username ? `@${username}` : undefined]
    .filter(Boolean)
    .join(' ');
  const markdown = `# ${title}\n\n${attribution ? `${attribution}\n\n` : ''}${body}`;

  return finalize({
    canonicalUrl: url.toString(),
    source: 'x',
    title,
    author: username ? `@${username}` : displayName,
    publishedAt: stringField(data, 'created_at'),
    markdown,
    complete: true,
  });
}

async function fetchWeb(url: URL, env: Env): Promise<FetchedContent> {
  const response = await fetchWithTimeout(
    'https://api.firecrawl.dev/v2/scrape',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: url.toString(),
        formats: ['markdown'],
        onlyMainContent: true,
        // onlyMainContentのDOMフィルタを抜けた目次や関連記事を、LLMで落とす。
        onlyCleanContent: true,
      }),
    },
    // Firecrawl側のtimeoutは既定で60秒。同じ値にすると必ずこちらが先に中断し、
    // Firecrawlが返す失敗理由を受け取れなくなるため、余裕を持たせる。
    75_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  const root = asRecord(await response.json());
  const data = asRecord(root?.data);
  const metadata = asRecord(data?.metadata);
  const markdown = stringField(data, 'markdown');

  // Firecrawlが取得先の404やブロックをどう報告するかは公式に明記されていない。
  // 成功・失敗のどちらの経路も本番のログから読めるようにしておく。
  console.log(
    JSON.stringify({
      stage: 'fetch',
      source: 'web',
      url: url.toString(),
      firecrawlSuccess: root?.success,
      statusCode: metadata?.statusCode,
      firecrawlError: metadata?.error,
      markdownLength: markdown?.length ?? 0,
    }),
  );

  if (root?.success !== true) throw new ClipError('Firecrawl reported failure', 'fetch', false);
  if (!markdown) throw new ClipError('Firecrawl returned no Markdown', 'fetch', false);

  return finalize({
    canonicalUrl: url.toString(),
    source: 'web',
    title: stringField(metadata, 'title') ?? firstHeading(markdown) ?? url.hostname,
    author: stringField(metadata, 'author'),
    publishedAt: stringField(metadata, 'publishedTime') ?? stringField(metadata, 'published_at'),
    markdown,
    complete: true,
  });
}

export async function fetchContent(rawUrl: string, env: Env): Promise<FetchedContent> {
  const url = canonicalizeUrl(rawUrl);
  switch (classifyUrl(url)) {
    case 'qiita':
      return fetchQiita(url);
    case 'zenn':
      return fetchZenn(url);
    case 'x':
      return fetchX(url, env);
    case 'web':
      return fetchWeb(url, env);
  }
}
