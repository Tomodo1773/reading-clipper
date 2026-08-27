/**
 * 意味づけの残るHTMLをMarkdownへ戻す、共有の変換器（ADR 0003、ADR 0024）。
 *
 * 依存パッケージは追加しない。`turndown`のような汎用ライブラリはDOM実装を伴い、
 * 対象が「本文だけを含む、要素の種類を数えられるHTML」に限られる以上、割に合わない。
 *
 * **このモジュールは特定のサイトを知らない。** ZennやarXivのように、そのサイトでしか
 * 意味を持たない要素（`embed-katex`、`math[alttext]`など）は`rules`として外から渡す。
 * 以前はZenn固有の分岐がこの中に直接書かれていたが、2つ目の利用者が現れた時点で
 * 共有部分と固有部分の境界が見えたため、分けた。
 */

import { decodeEntities, parseAttributes } from './html';

export type HtmlNode = string | HtmlElement;

export interface HtmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

/**
 * サイト固有ルールから、変換器の中身を呼び戻すための入口。
 * ルールは「自分で組み立てた結果を返す」か「`undefined`を返して共通処理に任せる」かを選ぶ。
 *
 * ここに置くのは、設定（`baseUrl`とルール自身）を閉じ込めた再帰の入口だけである。
 * `codeBlock`のように引数だけで決まる組み立ては、下の平の関数として公開する。
 */
export interface RenderContext {
  renderInline(nodes: HtmlNode[]): string;
  renderBlocks(nodes: HtmlNode[]): string;
}

export type RenderRule = (element: HtmlElement, context: RenderContext) => string | undefined;

/** インラインとブロックで1つずつ。どちらも省ける。 */
export interface RenderRules {
  inline?: RenderRule;
  block?: RenderRule;
}

export interface HtmlToMarkdownOptions {
  /**
   * 相対URLを解決する文書のURL。HTMLの相対URLは文書のURLで解決するのが本来の意味なので、
   * サイト固有ルールではなくここで扱う。絶対URLしか含まないHTMLでは結果が変わらない。
   */
  baseUrl?: string;
  rules?: RenderRules;
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

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

export function parseHtml(html: string): HtmlNode[] {
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
    if (!VOID_TAGS.has(tag)) stack.push(element);
  }
  if (cursor < html.length) top().children.push(decodeEntities(html.slice(cursor)));
  return root.children;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return typeof node !== 'string';
}

export function classList(element: HtmlElement): string[] {
  return (element.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

export function findDescendant(
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

export function collectDescendants(
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

export function textContent(nodes: HtmlNode[]): string {
  return nodes.map((node) => (isElement(node) ? textContent(node.children) : node)).join('');
}

function codeSpan(value: string): string {
  const text = value.replace(/\r?\n/g, ' ');
  const longest = (text.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length), 0);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * コードブロック。言語はファイル名の拡張子から決まり、フェンスの長さは中身に合わせて伸ばす。
 * 中身が`<pre>`から来るとは限らないため、要素ではなく文字列を受ける。
 */
export function codeBlock(code: string, filename?: string): string {
  const body = code.replace(/\n+$/, '');
  const fenceLength = (body.match(/^`{3,}/gm) ?? []).reduce(
    (length, run) => Math.max(length, run.length + 1),
    3,
  );
  const fence = '`'.repeat(fenceLength);
  const language = filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? '';
  const header = filename ? `\`${filename}\`\n\n` : '';
  return `${header}${fence}${language}\n${body}\n${fence}`;
}

/**
 * 数式。LaTeX原文をどこから取るかはサイトによって違う（Zennは要素の中身、arXivは`alttext`）が、
 * Markdownとしての書き方は同じなので、組み立てはここに1つだけ置く。
 */
export function math(tex: string, block: boolean): string {
  return block ? `$$\n${tex}\n$$` : `$${tex}$`;
}

/** 引用のように、各行へ同じ印を付ける。空行には末尾の空白を残さない。 */
export function prefixLines(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n');
}

/**
 * 変換器を1つ作る。関数どうしが相互再帰しているため、設定を全部の引数へ足すのではなく
 * クロージャで包む。返るのは、解析済みのノード列をMarkdownにする関数1つ。
 *
 * 解析（`parseHtml`）を中に含めないのは、本文のかたまりだけを選んでから渡す使い方が
 * あるため（arXivは左のTOCサイドバーを木の段階で捨てる）。
 */
export function createHtmlToMarkdown(
  options: HtmlToMarkdownOptions = {},
): (nodes: HtmlNode[]) => string {
  const { baseUrl, rules } = options;

  const resolveUrl = (value: string): string => {
    if (!baseUrl) return value;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return value;
    }
  };

  const context: RenderContext = {
    renderInline: (nodes) => renderInline(nodes),
    renderBlocks: (nodes) => renderBlocks(nodes),
  };

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
        const ruled = rules?.inline?.(node, context);
        if (ruled !== undefined) return ruled;
        switch (node.tag) {
          case 'br':
            return '\n';
          case 'img': {
            const src = node.attrs.src;
            return src ? `![${node.attrs.alt ?? ''}](${resolveUrl(src)})` : '';
          }
          case 'a': {
            const text = renderInline(node.children).trim();
            const href = node.attrs.href;
            if (!text) return '';
            return href && !href.startsWith('#') ? `[${text}](${resolveUrl(href)})` : text;
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
    const ruled = rules?.block?.(element, context);
    if (ruled !== undefined) return ruled;
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
        return codeBlock(textContent(element.children));
      case 'ul':
        return renderList(element, false);
      case 'ol':
        return renderList(element, true);
      case 'table':
        return renderTable(element);
      case 'blockquote':
        return prefixLines(renderBlocks(element.children), '> ');
      case 'details': {
        const summary = element.children.filter(isElement).find((node) => node.tag === 'summary');
        const title = summary ? renderInline(summary.children).trim() : '';
        const body = renderBlocks(element.children.filter((node) => node !== summary));
        return [title ? `**${title}**` : '', body].filter(Boolean).join('\n\n');
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

  return (nodes) => renderBlocks(nodes).trim();
}
