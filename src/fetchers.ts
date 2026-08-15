import { ClipError } from './errors';
import type { Env, FetchedContent } from './types';
import { canonicalizeUrl, classifyUrl, extractXPostId } from './url';
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
        maxAge: 0,
      }),
    },
    60_000,
    'fetch',
  );
  assertOk(response, 'fetch');
  const root = asRecord(await response.json());
  if (root?.success !== true) throw new ClipError('Firecrawl reported failure', 'fetch', false);
  const data = asRecord(root.data);
  const metadata = asRecord(data?.metadata);
  const markdown = stringField(data, 'markdown');
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
    case 'x':
      return fetchX(url, env);
    case 'web':
      return fetchWeb(url, env);
  }
}
