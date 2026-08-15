import type { ClipJob, FetchedContent } from './types';
import type { SummaryResult } from './summarizer';

export interface StoredClip {
  slackEventId?: string;
  summaryStatus?: 'succeeded' | 'failed';
  summary?: SummaryResult;
  fetchComplete?: boolean;
}

function frontMatterValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function safeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim() || 'Untitled';
}

export function renderClipMarkdown(options: {
  job: ClipJob;
  content: FetchedContent;
  summary?: SummaryResult;
}): string {
  const { job, content, summary } = options;
  const fields: Array<[string, string | boolean | undefined]> = [
    ['source_url', content.canonicalUrl],
    ['source_type', content.source],
    ['title', content.title],
    ['author', content.author],
    ['published_at', content.publishedAt],
    ['clipped_at', job.receivedAt],
    ['slack_event_id', job.jobId],
    ['fetch_complete', content.complete],
    ['summary_status', summary ? 'succeeded' : 'failed'],
  ];
  const frontMatter = fields
    .filter((field): field is [string, string | boolean] => field[1] !== undefined)
    .map(([key, value]) => `${key}: ${frontMatterValue(value)}`)
    .join('\n');
  const summaryText = summary
    ? summary.text
    : 'AI要約の生成に失敗したため、本文のみ保存した。';
  return `---\n${frontMatter}\n---\n\n# ${safeHeading(content.title)}\n\n[元URL](${content.canonicalUrl})\n\n## 要約\n\n${summaryText}\n\n## 取得内容\n\n${content.markdown.trim()}\n`;
}

export function parseStoredClip(markdown: string): StoredClip {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  const values = new Map<string, unknown>();
  for (const line of match?.[1]?.split('\n') ?? []) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      values.set(key, JSON.parse(raw));
    } catch {
      values.set(key, raw);
    }
  }
  const summaryMatch = markdown.match(/\n## 要約\n\n([\s\S]*?)\n\n## 取得内容\n/);
  const summaryStatus = values.get('summary_status');
  const summaryText = summaryMatch?.[1]?.trim();
  return {
    slackEventId:
      typeof values.get('slack_event_id') === 'string'
        ? (values.get('slack_event_id') as string)
        : undefined,
    summaryStatus:
      summaryStatus === 'succeeded' || summaryStatus === 'failed' ? summaryStatus : undefined,
    summary: summaryStatus === 'succeeded' && summaryText ? { text: summaryText } : undefined,
    fetchComplete:
      typeof values.get('fetch_complete') === 'boolean'
        ? (values.get('fetch_complete') as boolean)
        : undefined,
  };
}
