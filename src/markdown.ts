import type { FetchedContent } from './types';

function frontMatterValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

/** フロントマターの直下に、取得した本文をそのまま置く。 */
export function renderClipMarkdown(content: FetchedContent, clippedAt: string): string {
  const fields: Array<[string, string | boolean | undefined]> = [
    ['source_url', content.canonicalUrl],
    ['source_type', content.source],
    ['title', content.title],
    ['author', content.author],
    ['published_at', content.publishedAt],
    ['clipped_at', clippedAt],
    ['fetch_complete', content.complete],
  ];
  const frontMatter = fields
    .filter((field): field is [string, string | boolean] => field[1] !== undefined)
    .map(([key, value]) => `${key}: ${frontMatterValue(value)}`)
    .join('\n');
  return `---\n${frontMatter}\n---\n\n${content.markdown.trim()}\n`;
}
