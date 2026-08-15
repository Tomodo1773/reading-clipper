import type { ClipJob, FetchedContent } from './types';

function frontMatterValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

/** フロントマターの直下に、取得した本文をそのまま置く。 */
export function renderClipMarkdown(options: { job: ClipJob; content: FetchedContent }): string {
  const { job, content } = options;
  const fields: Array<[string, string | boolean | undefined]> = [
    ['source_url', content.canonicalUrl],
    ['source_type', content.source],
    ['title', content.title],
    ['author', content.author],
    ['published_at', content.publishedAt],
    ['clipped_at', job.receivedAt],
    ['fetch_complete', content.complete],
  ];
  const frontMatter = fields
    .filter((field): field is [string, string | boolean] => field[1] !== undefined)
    .map(([key, value]) => `${key}: ${frontMatterValue(value)}`)
    .join('\n');
  return `---\n${frontMatter}\n---\n\n${content.markdown.trim()}\n`;
}
