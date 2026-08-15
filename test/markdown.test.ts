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
      summary: { sentences: ['テーマと結論。', '主要な内容。'] },
    });
    expect(markdown).toContain('summary_status: "succeeded"');
    expect(parseStoredClip(markdown)).toEqual({
      slackEventId: 'Ev123',
      summaryStatus: 'succeeded',
      summary: { sentences: ['テーマと結論。', '主要な内容。'] },
      fetchComplete: false,
    });
  });
});
