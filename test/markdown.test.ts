import { describe, expect, it } from 'vitest';
import { parseStoredClip, renderClipMarkdown } from '../src/markdown';

describe('stored Markdown', () => {
  it('round-trips idempotency and summary metadata', () => {
    const markdown = renderClipMarkdown({
      job: {
        version: 1,
        jobId: 'Ev123',
        url: 'https://example.com/a',
        slackChannel: 'D1',
        slackThreadTs: '1.1',
        receivedAt: '2026-08-15T00:00:00.000Z',
        ignoredUrlCount: 0,
      },
      content: {
        canonicalUrl: 'https://example.com/a',
        source: 'web',
        title: 'Example',
        markdown: '# Body',
        complete: false,
      },
      summary: { text: 'ああ、Workerの記事ね。要するに重い処理はQueueへ逃がせってことよ。' },
    });
    expect(markdown).toContain('summary_status: "succeeded"');
    expect(parseStoredClip(markdown)).toEqual({
      slackEventId: 'Ev123',
      summaryStatus: 'succeeded',
      summary: { text: 'ああ、Workerの記事ね。要するに重い処理はQueueへ逃がせってことよ。' },
      fetchComplete: false,
    });
  });
});
