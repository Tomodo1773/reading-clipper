import { ClipError, isRetryableStatus } from './errors';
import { splitFrontMatter } from './front-matter';
import { findOgImage, readMetaTags } from './html';
import {
  classList,
  codeBlock,
  collectDescendants,
  createHtmlToMarkdown,
  findDescendant,
  type HtmlElement,
  type HtmlNode,
  math,
  parseHtml,
  prefixLines,
  type RenderRules,
  textContent,
} from './html-markdown';
import type { Env, FetchedContent } from './types';
import {
  canonicalizeUrl,
  classifyUrl,
  extractArxivId,
  extractXPostId,
  extractZennArticleSlug,
} from './url';
import { asRecord, assertOk, fetchWithTimeout, stringField } from './utils';

const MAX_CONTENT_CHARS = 200_000;

/**
 * 各フェッチャーが知っていること。**どのURLの記事かは含めない。**
 *
 * クリップの識別（保存先パス・`source_url`・D1の`url`）は`canonicalUrl`から決まる。
 * それを各フェッチャーがそれぞれ組み立てると、どれか1つがずれたときに黙って壊れる。
 * 取り方を選んだ`fetchContent`が1箇所で決める（ADR 0012）。
 */
type FetchedBody = Omit<FetchedContent, 'canonicalUrl' | 'imageUrl'>;

function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function finalize(content: FetchedBody): FetchedBody {
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

/**
 * Qiitaの`.md`は本文の前にYAMLフロントマターを置く。記事タイトルはそこにしか無く、
 * 本文は見出しから始まるため、本文の最初の見出しをタイトルとして扱ってはいけない。
 */
async function fetchQiita(url: URL): Promise<FetchedBody> {
  const markdownUrl = new URL(url);
  if (!markdownUrl.pathname.endsWith('.md')) markdownUrl.pathname += '.md';
  const response = await fetchWithTimeout(markdownUrl, { headers: { accept: 'text/markdown' } }, 15_000, 'fetch');
  assertOk(response, 'fetch');
  const { fields, body } = splitFrontMatter(await response.text());
  return finalize({
    source: 'qiita',
    title: fields.title || (url.pathname.split('/').at(-1) ?? 'Qiita article'),
    author: fields.author || url.pathname.split('/').filter(Boolean)[0],
    markdown: body,
    complete: true,
  });
}

// Zennは記事のMarkdown原稿を公開していない。取得できるのはzenn-markdown-htmlが生成した
// 意味づけの残るHTMLだけなので、その範囲をMarkdownへ戻す（ADR 0003）。
//
// 変換そのものは`html-markdown.ts`の共有の変換器が行う。ここに置くのは、zenn-markdown-html
// でしか意味を持たない要素だけである。
const renderZenn = createHtmlToMarkdown({
  rules: {
    inline: (element) => {
      if (element.tag !== 'embed-katex') return undefined;
      const tex = textContent(element.children).trim();
      if (!tex) return '';
      return math(tex, Boolean(element.attrs['display-mode']));
    },
    block: (element, { renderBlocks }) => {
      // Zennの`:::message`。記号を表す`span.msg-symbol`は捨て、本文だけ引用にする。
      if (element.tag === 'aside') {
        const content = findDescendant(element.children, (node) =>
          classList(node).includes('msg-content'),
        );
        const body = renderBlocks(content?.children ?? element.children);
        return body ? prefixLines(body, '> ') : '';
      }
      if (element.tag === 'div' && classList(element).includes('code-block-container')) {
        const pre = findDescendant(element.children, (node) => node.tag === 'pre');
        const filename = findDescendant(element.children, (node) =>
          classList(node).includes('code-block-filename'),
        );
        if (pre) {
          return codeBlock(
            textContent(pre.children),
            textContent(filename?.children ?? []).trim() || undefined,
          );
        }
      }
      return undefined;
    },
  },
});

function zennHtmlToMarkdown(html: string): string {
  return renderZenn(parseHtml(html));
}

async function fetchZenn(url: URL): Promise<FetchedBody> {
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

async function fetchX(url: URL, env: Env): Promise<FetchedBody> {
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
    source: 'x',
    title,
    author: username ? `@${username}` : displayName,
    publishedAt: stringField(data, 'created_at'),
    markdown,
    complete: true,
  });
}

// arXivはLaTeXMLが生成した全文HTMLを配っている（ADR 0024）。absページは論文の入口で
// 本文を1文字も含まないため、そちらを取るとアブストラクトだけが保存される。
//
// 変換そのものは`html-markdown.ts`の共有の変換器が行う。ここに置くのは、LaTeXMLの出力で
// しか意味を持たない要素だけである。
/**
 * タイトルと抄録の間に並ぶ書誌の飾り。どれも論文の中身ではなく、フロントマターか
 * 元ページで足りる。落とさないと、どの論文もここから始まり、ダイジェストの抜粋
 * （ADR 0011）も抄録へ届かずにここで埋まる。
 */
const ARXIV_FRONT_MATTER = new Set([
  // 著者の所属とメールアドレスが1,500字ほど。名前はフロントマターへ`citation_author`から入る。
  'ltx_authors',
  // ACMのCCS分類。分類語が100字ほど、抄録の手前に居座る。
  'ltx_pubnotes',
]);

function isArxivFrontMatter(element: HtmlElement): boolean {
  return classList(element).some((name) => ARXIV_FRONT_MATTER.has(name));
}

const arxivRules: RenderRules = {
  inline: (element) => {
    if (isArxivFrontMatter(element)) return '';
    // LaTeX原文が`alttext`に入っている。既定の経路へ落とすとMathMLの中身とTeX注釈が二重に出る。
    if (element.tag !== 'math') return undefined;
    const tex = element.attrs.alttext?.trim();
    if (!tex) return '';
    return math(tex, element.attrs.display === 'block');
  },
  block: (element, { renderInline }) => {
    if (isArxivFrontMatter(element)) return '';
    // アルゴリズムの擬似コード。`<pre>`ではなく行ごとの`div`なので、放置すると1行ずつ段落へ割れる。
    if (element.tag !== 'div' || !classList(element).includes('ltx_listing')) return undefined;
    const code = collectDescendants(element.children, (node) =>
      classList(node).includes('ltx_listingline'),
    )
      .map((line) => renderInline(line.children).replace(/\s+/g, ' ').trim())
      .join('\n');
    return code ? codeBlock(code) : '';
  },
};

/** absページの`Abstract:`という飾りを落とす。全文HTMLが無い論文で本文の代わりに使う。 */
function arxivAbstract(nodes: HtmlNode[]): string | undefined {
  const blockquote = findDescendant(
    nodes,
    (node) => node.tag === 'blockquote' && classList(node).includes('abstract'),
  );
  const text = textContent(blockquote?.children ?? []).replace(/^\s*Abstract:\s*/i, '').trim();
  return text || undefined;
}

/**
 * 記事ページのHTMLをまるごと取る。`<head>`だけで足りる`fetchPageHead`とは別物で、
 * こちらは本文や構造化データが`<body>`側にあるフェッチャーが使う。
 */
async function fetchPageHtml(pageUrl: string): Promise<string> {
  const response = await fetchWithTimeout(
    pageUrl,
    { headers: { accept: 'text/html' } },
    30_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  return response.text();
}

/**
 * absページを起点にする。ここには整ったメタデータ（`citation_*`）と、全文HTMLへの
 * **版まで確定したリンク**の両方があるため、在庫の有無を404で確かめる必要がなく、
 * 2回のリクエストの間に改版が入っても版を取り違えない。
 *
 * 著者を全文HTML側から取らないのは、そこには所属とメールアドレスが混ざるためである。
 */
async function fetchArxiv(url: URL): Promise<FetchedBody> {
  const id = extractArxivId(url);
  if (!id) throw new ClipError('arXiv paper id was not found', 'validation', false);

  const absUrl = `https://arxiv.org/abs/${id}`;
  const absHtml = await fetchPageHtml(absUrl);
  const absNodes = parseHtml(absHtml);

  const meta = readMetaTags(absHtml);
  const authors = meta.filter((tag) => tag.key === 'citation_author').map((tag) => tag.content);
  const common = {
    source: 'arxiv',
    title: meta.find((tag) => tag.key === 'citation_title')?.content ?? id,
    author: authors.join(', ') || undefined,
    // `citation_date`は`2026/08/18`の形で、初版の投稿日を指す。
    publishedAt: meta.find((tag) => tag.key === 'citation_date')?.content.replace(/\//g, '-'),
  } as const;

  // 全文HTMLの在庫は、absページのこのリンクの有無がarXiv自身の宣言になっている。
  const link = findDescendant(
    absNodes,
    (node) => node.tag === 'a' && node.attrs.id === 'latexml-download-link',
  );
  const htmlUrl = link?.attrs.href && new URL(link.attrs.href, absUrl).toString();
  if (!htmlUrl) {
    const abstract = arxivAbstract(absNodes);
    if (!abstract) throw new ClipError('arXiv abs page had no abstract', 'fetch', false);
    return finalize({ ...common, markdown: abstract, complete: false });
  }

  const paperHtml = await fetchPageHtml(htmlUrl);
  // 左のTOCサイドバーには本文と同じ文字列が並ぶため、テキストではなく構造で本文を選ぶ。
  const document = findDescendant(parseHtml(paperHtml), (node) =>
    classList(node).includes('ltx_document'),
  );
  if (!document) throw new ClipError('arXiv HTML had no ltx_document', 'fetch', false);

  return finalize({
    ...common,
    version: new URL(htmlUrl).pathname.match(/v\d+$/i)?.[0],
    // 図の`src`が相対パスで来るため、取得したページのURLで解決する。
    markdown: createHtmlToMarkdown({ baseUrl: htmlUrl, rules: arxivRules })(document.children),
    complete: true,
  });
}

// スライド共有サイトは、記事と違って本文のHTMLを持たない。どちらも公開しているのは
// 発表ページに埋め込まれた構造化データ（schema.org）で、そこから取れる範囲がサイトで
// はっきり違う。Speaker Deckはスライド1枚ずつの文字起こしまで載せ、ドクセルは投稿者が
// 書いた概要までしか載せない。
//
// 取れた範囲は本文の末尾に一言で書き残す。フロントマターの`fetch_complete`は「末尾が
// 省略されている」の意味なので、スライドの事情はそこでは表せない。後から読んだAIに
// 「これはスライドなので本文はあてにならない」と分かることの方が大事で、それは
// 本文に書くのが一番確実に届く（ADR 0025）。

/**
 * `<script type="application/ld+json">`から、`@type`が一致する最初のものを返す。
 *
 * 1ページに複数のブロックが並び、1つのブロックが配列のこともある（ドクセルはパンくずを
 * 配列で2本並べる）。JSONとして壊れているブロックは飛ばし、読めたものだけを見る。
 */
function findJsonLd(html: string, type: string): Record<string, unknown> | undefined {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  );
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? '');
    } catch {
      continue;
    }
    for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = asRecord(node);
      if (record?.['@type'] === type) return record;
    }
  }
  return undefined;
}

const SLIDE_TRANSCRIPT_NOTE =
  '> この本文はスライドをPDFから機械的に文字起こししたもの。読み順の乱れ、単語の分割、図中の文字の混入がある。元がスライドのため、これ以上の本文は取得できない。';

const SLIDE_DESCRIPTION_ONLY_NOTE =
  '> スライドの文字が公開されていないため、取得できたのは投稿者が書いた概要だけ。スライド本体の中身は含まれない。';

/**
 * Speaker Deckは発表ページの構造化データ（`PresentationDigitalDocument`）に、題名・著者・
 * 公開日・説明文と、**スライド1枚ずつの文字起こし**（`hasPart`）を載せている。ページを
 * 1回取れば足りる。
 *
 * 文字起こしはPDFから機械的に抜いた文字で、整形はしない。読み順を直すには元のレイアウトが
 * 要るが、それは公開されていない。推測で組み替えると、元より読めない本文になる。
 *
 * 画像だけで作られた発表には文字起こしが無い。そのときは説明文だけが残る。
 */
async function fetchSpeakerdeck(url: URL): Promise<FetchedBody> {
  const html = await fetchPageHtml(url.toString());
  const deck = findJsonLd(html, 'PresentationDigitalDocument');
  const title = stringField(deck, 'name');
  if (!deck || !title) throw new ClipError('Speaker Deck page had no deck metadata', 'fetch', false);

  const slides = (Array.isArray(deck.hasPart) ? deck.hasPart : [])
    .map((part, index) => {
      const slide = asRecord(part);
      return {
        // 何枚目かはSpeaker Deck自身が`position`で書いている。並んでいた順ではなくそちらに従う。
        // 書かれていなければ、並んでいた位置がそのまま最良の手掛かりになる。
        position: typeof slide?.position === 'number' ? slide.position : index,
        // スライドの区切りに改ページの制御文字が入っている。
        text: (stringField(slide, 'text') ?? '').replace(/\f/g, '').trim(),
      };
    })
    .filter((slide) => slide.text)
    .sort((left, right) => left.position - right.position);

  const sections = [`# ${title}`, stringField(deck, 'description')];
  for (const [index, slide] of slides.entries()) {
    sections.push(`## スライド ${index + 1}`, slide.text);
  }
  sections.push(slides.length > 0 ? SLIDE_TRANSCRIPT_NOTE : SLIDE_DESCRIPTION_ONLY_NOTE);

  return finalize({
    source: 'speakerdeck',
    title,
    author: stringField(asRecord(deck.author), 'name'),
    publishedAt: stringField(deck, 'datePublished'),
    markdown: sections.filter(Boolean).join('\n\n'),
    complete: slides.length > 0,
  });
}

/**
 * ドクセルはスライドの文字をどこにも出していない。発表ページのHTMLにも、埋め込み
 * プレイヤーが読むデータにも入っておらず（プレイヤーが持つのはページ数とリンクの座標
 * だけ）、PDFのダウンロード経路はrobots.txtで拒否されている。
 *
 * 取れるのは構造化データ（`Article`）の題名・著者・公開日と、投稿者が書いた概要まで。
 * **本文は常に概要止まりなので`complete`は立てない**（ADR 0025）。
 */
async function fetchDocswell(url: URL): Promise<FetchedBody> {
  const html = await fetchPageHtml(url.toString());
  const slide = findJsonLd(html, 'Article');
  const title = stringField(slide, 'headline');
  if (!slide || !title) throw new ClipError('Docswell page had no slide metadata', 'fetch', false);

  return finalize({
    source: 'docswell',
    title,
    author: stringField(asRecord(slide.author), 'name'),
    publishedAt: stringField(slide, 'datePublished'),
    markdown: [`# ${title}`, stringField(slide, 'description'), SLIDE_DESCRIPTION_ONLY_NOTE]
      .filter(Boolean)
      .join('\n\n'),
    complete: false,
  });
}

async function fetchWeb(url: URL, env: Env): Promise<FetchedBody> {
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
        // `onlyCleanContent`は付けない。boilerplateを削るのではなく、LLMがMarkdown全体を
        // 出力し直す実装で、日本語の長い記事では本文の脱落と表の書き換えが起きる。
        // 所要も4秒から150秒へ延び、こちらのtimeoutに間に合わない。
        //
        // `timeout`は明示しないと効かない。省くと応答が返らないまま数分待たされるが、
        // 渡せば失敗理由の入った408が返る。
        timeout: 45_000,
      }),
    },
    // Firecrawlの`timeout`は目安で、実測では10秒ほど超えてから408が返る。
    // それを待ち切れる値にして、Firecrawlが書いた失敗理由をログへ残す。
    75_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  const root = asRecord(await response.json());
  const data = asRecord(root?.data);
  const metadata = asRecord(data?.metadata);
  const markdown = stringField(data, 'markdown');

  // 失敗時は`data`ごと欠落するため、理由はトップレベルの`error`にしか入らない。
  if (root?.success !== true) {
    throw new ClipError(`Firecrawl reported failure: ${stringField(root, 'error') ?? 'no reason'}`, 'fetch', false);
  }
  // Firecrawlは取得先が404でも`success: true`で404ページのMarkdownを返す。
  const targetStatus = metadata?.statusCode;
  if (typeof targetStatus === 'number' && targetStatus >= 400) {
    throw new ClipError(
      `Firecrawl target returned ${targetStatus}`,
      'fetch',
      isRetryableStatus(targetStatus),
      targetStatus,
    );
  }
  if (!markdown) throw new ClipError('Firecrawl returned no Markdown', 'fetch', false);

  return finalize({
    source: 'web',
    title: stringField(metadata, 'title') ?? firstHeading(markdown) ?? url.hostname,
    author: stringField(metadata, 'author'),
    publishedAt: stringField(metadata, 'publishedTime') ?? stringField(metadata, 'published_at'),
    markdown,
    complete: true,
  });
}

/** `<head>`はこの範囲に収まる。全文を読むと記事によっては数MBになる。 */
const PAGE_HEAD_SCAN_BYTES = 256 * 1024;

/** 既定のUser-Agentだとmetaを返さないサイトがあるため、素性を書いたものを送る。 */
const PAGE_HEAD_USER_AGENT = 'Mozilla/5.0 (compatible; reading-clipper/1.0)';

/** `</head>`まで、または上限まで読んで打ち切る。本文は要らない。 */
async function readHead(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head\s*>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

/**
 * 記事ページの`<head>`だけを読んで、**着いた先のURL**と`og:image`を返す（ADR 0011 / ADR 0012）。
 *
 * `og:image`は、フェッチャーが叩くAPI（Zennの非公式API・Qiitaの`.md`・X API）がどれも画像を
 * 返さないため、ソースで分岐せず記事ページのHTMLから一律に取る。
 *
 * `resolvedUrl`は、リダイレクトを追った結果そのもの。`share.google`のような中継ページは、
 * ここで記事本体のURLに解決される。中継ページの解決にHEADは使えない（中間ホップがHEADには
 * 200を返して止まり、GETにだけ301を返す実例がある）ため、この部分GETが解決の役目も兼ねる。
 *
 * サムネイルが無くても、着いた先が分からなくても、クリップの保存は成立する。
 * **失敗はすべて握り潰し、`resolvedUrl`は入力のままにして投げない**。
 */
export async function fetchPageHead(
  pageUrl: string,
): Promise<{ resolvedUrl: string; imageUrl?: string }> {
  try {
    const response = await fetchWithTimeout(
      pageUrl,
      { headers: { accept: 'text/html', 'user-agent': PAGE_HEAD_USER_AGENT } },
      15_000,
      'fetch',
    );
    // `fetch`はリダイレクトを追った後の最終URLを`response.url`に入れる。
    const resolvedUrl = response.url || pageUrl;
    if (!response.ok) {
      await response.body?.cancel();
      return { resolvedUrl };
    }
    const head = await readHead(response, PAGE_HEAD_SCAN_BYTES);
    return { resolvedUrl, imageUrl: findOgImage(head, resolvedUrl) };
  } catch {
    return { resolvedUrl: pageUrl };
  }
}

function fetchBody(url: URL, env: Env): Promise<FetchedBody> {
  switch (classifyUrl(url)) {
    case 'qiita':
      return fetchQiita(url);
    case 'zenn':
      return fetchZenn(url);
    case 'x':
      return fetchX(url, env);
    case 'arxiv':
      return fetchArxiv(url);
    case 'speakerdeck':
      return fetchSpeakerdeck(url);
    case 'docswell':
      return fetchDocswell(url);
    case 'web':
      return fetchWeb(url, env);
  }
}

export async function fetchContent(rawUrl: string, env: Env): Promise<FetchedContent> {
  const url = canonicalizeUrl(rawUrl);
  // どのURLの記事かは、取り方を選んだここが決める。フェッチャーは中身だけを返す。
  return { ...(await fetchBody(url, env)), canonicalUrl: url.toString() };
}

/**
 * 1件ぶんの記事を読み込む。`load_content`ツールの本体（ADR 0012）。
 *
 * リダイレクトを追ってから種類を判定するため、`share.google`経由でもZennの記事はZennとして
 * 取れる。**着いた先を使うのは301が「この資源はここへ移った」というサーバー自身の宣言だから**で、
 * 本文の意味を読んで行き先を変えているわけではない。中身の意味による判断はAIの側にある。
 *
 * 着いた先が確定しないと本文をどこから取るか決まらないので、`fetchPageHead`と本文取得は
 * 直列になる。増えるのは`<head>`までの部分GET1本だけで、リクエストの本数自体は変わらない。
 */
export async function loadContent(rawUrl: string, env: Env): Promise<FetchedContent> {
  // 不正なURLはここで`validation`として弾く。取得を1本も投げずに済む。
  const requestedUrl = canonicalizeUrl(rawUrl).toString();
  const { resolvedUrl, imageUrl } = await fetchPageHead(requestedUrl);
  const content = await fetchContent(resolvedUrl, env);
  return { ...content, imageUrl };
}
