import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGitHubTokenCache } from '../src/github';
import { renderClipMarkdown } from '../src/markdown';
import { handleQueueMessage, processClipJob } from '../src/processor';
import type { ClipJob } from '../src/types';
import { base64ToUtf8, utf8ToBase64 } from '../src/utils';
import { generatePrivateKeyPem, makeEnv } from './helpers';

const job: ClipJob = {
  version: 1,
  jobId: 'EvProcess',
  url: 'https://qiita.com/alice/items/abc',
  slackChannel: 'D123',
  slackThreadTs: '1700000000.000100',
  receivedAt: '2026-08-15T00:00:00.000Z',
  ignoredUrlCount: 0,
};

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  privateKeyPem = await generatePrivateKeyPem();
});

afterEach(() => vi.restoreAllMocks());

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('clip processor', () => {
  it('fetches, summarizes, saves and replies in one successful flow', async () => {
    let savedMarkdown = '';
    let slackBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/') && method === 'POST') {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'GET') {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url === 'https://qiita.com/alice/items/abc.md') {
        return new Response('# Worker設計\n\nQueueで重い処理を分離する。', { status: 200 });
      }
      if (url.includes('/compat/chat/completions')) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sentences: ['Workerの非同期処理について説明している。', 'Queue分離が主な結論だ。'],
                }),
              },
            },
          ],
        });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        savedMarkdown = base64ToUtf8(body.content);
        return jsonResponse({
          content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/clip.md' },
        }, 201);
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        slackBody = JSON.parse(String(init?.body));
        return jsonResponse({ ok: true, ts: '1.2' });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await processClipJob(job, makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }), 1);

    expect(savedMarkdown).toContain('slack_event_id: "EvProcess"');
    expect(savedMarkdown).toContain('summary_status: "succeeded"');
    expect(savedMarkdown).toContain('Queue分離が主な結論だ。');
    expect(slackBody?.thread_ts).toBe(job.slackThreadTs);
    expect(slackBody?.text).toContain('GitHubへの保存に成功した');
  });

  it('saves the body without a summary on the final attempt', async () => {
    let savedMarkdown = '';
    let slackText = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'GET') {
        return jsonResponse({}, 404);
      }
      if (url.endsWith('/abc.md')) return new Response('# Article\n\nBody', { status: 200 });
      if (url.includes('/compat/chat/completions')) return jsonResponse({}, 503);
      if (url.includes('/repos/example/clips/contents/') && method === 'PUT') {
        savedMarkdown = base64ToUtf8(JSON.parse(String(init?.body)).content);
        return jsonResponse({
          content: { sha: 'sha', html_url: 'https://github.com/example/clips/blob/main/clip.md' },
        }, 201);
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        slackText = JSON.parse(String(init?.body)).text;
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await processClipJob(job, makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }), 4);
    expect(savedMarkdown).toContain('summary_status: "failed"');
    expect(slackText).toContain('AI要約には失敗したけれど');
  });

  it('reuses a stored result for the same Slack event', async () => {
    const existingMarkdown = renderClipMarkdown({
      job,
      content: {
        canonicalUrl: job.url,
        source: 'qiita',
        title: 'Stored',
        markdown: '# Stored',
        complete: true,
      },
      summary: { sentences: ['保存済みの要約。', '保存済みの根拠。'] },
    });
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/repos/example/clips/contents/')) {
        return jsonResponse({
          sha: 'stored-sha',
          content: utf8ToBase64(existingMarkdown),
          html_url: 'https://github.com/example/clips/blob/main/stored.md',
        });
      }
      if (url === 'https://slack.com/api/chat.postMessage') return jsonResponse({ ok: true });
      throw new Error(`unexpected request: ${url}`);
    });

    await processClipJob(job, makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }), 2);
    expect(requested.some((url) => url.endsWith('/abc.md'))).toBe(false);
    expect(requested.some((url) => url.includes('/compat/chat/completions'))).toBe(false);
  });

  it('acks permanent validation failures after notifying Slack', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      body: { ...job, url: 'file:///secret' },
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<ClipJob>;
    await handleQueueMessage(message, makeEnv());
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it('notifies and retries a transient final failure so Cloudflare can move it to the DLQ', async () => {
    let slackNotified = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/app/installations/')) return jsonResponse({}, 503);
      if (url === 'https://slack.com/api/chat.postMessage') {
        slackNotified = true;
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const message = { body: job, attempts: 4, ack, retry } as unknown as Message<ClipJob>;
    await handleQueueMessage(
      message,
      makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem }),
    );
    expect(slackNotified).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });
});
