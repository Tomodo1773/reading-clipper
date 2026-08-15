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
    let savedPath = '';
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
        return new Response(
          '---\ntitle: Worker設計\nauthor: alice\n---\n## 概要\n\nQueueで重い処理を分離する。',
          { status: 200 },
        );
      }
      if (url.includes('/compat/chat/completions')) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Workerの非同期処理の話ね。要するに重い処理はQueueへ分けなさい、ってことよ。',
                }),
              },
            },
          ],
        });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        savedPath = decodeURIComponent(url.split('/contents/')[1] ?? '');
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

    // 保存先は記事タイトル起点で、URLハッシュは付けない。
    expect(savedPath).toBe('clips/qiita.com/Worker設計.md');
    // フロントマターの直後から本文で、要約や見出しの追加はしない。
    expect(savedMarkdown).toBe(
      `---\nsource_url: "https://qiita.com/alice/items/abc"\nsource_type: "qiita"\ntitle: "Worker設計"\nauthor: "alice"\nclipped_at: "2026-08-15T00:00:00.000Z"\nfetch_complete: true\n---\n\n## 概要\n\nQueueで重い処理を分離する。\n`,
    );
    expect(savedMarkdown).not.toContain('要するに重い処理はQueueへ分けなさい、ってことよ。');
    expect(slackBody?.thread_ts).toBe(job.slackThreadTs);
    expect(slackBody?.text).toContain('要するに重い処理はQueueへ分けなさい、ってことよ。');
    expect(slackBody?.text).toContain('GitHubには保存しておいたわよ');
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
      if (url === 'https://qiita.com/alice/items/abc.md') {
        return new Response('---\ntitle: Article\nauthor: alice\n---\n# Article\n\nBody', { status: 200 });
      }
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
    expect(savedMarkdown).toBe(
      `---\nsource_url: "https://qiita.com/alice/items/abc"\nsource_type: "qiita"\ntitle: "Article"\nauthor: "alice"\nclipped_at: "2026-08-15T00:00:00.000Z"\nfetch_complete: true\n---\n\n# Article\n\nBody\n`,
    );
    expect(slackText).toContain('要約の方は失敗したけれど');
  });

  it('re-fetches, re-summarizes and overwrites when Slack redelivers the same event', async () => {
    const existingMarkdown = renderClipMarkdown(
      {
        canonicalUrl: job.url,
        source: 'qiita',
        title: 'Worker設計',
        markdown: '# Worker設計\n\n古い本文。',
        complete: true,
      },
      job.receivedAt,
    );
    const requested: string[] = [];
    let putSha: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requested.push(url);
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url === 'https://qiita.com/alice/items/abc.md') {
        return new Response('# Worker設計\n\n新しい本文。', { status: 200 });
      }
      if (url.includes('/compat/chat/completions')) {
        return jsonResponse({
          choices: [{ message: { content: JSON.stringify({ summary: '取り直した要約よ。' }) } }],
        });
      }
      if (url.includes('/repos/example/clips/contents/') && method === 'PUT') {
        putSha = JSON.parse(String(init?.body)).sha;
        return jsonResponse({
          content: { sha: 'new-sha', html_url: 'https://github.com/example/clips/blob/main/stored.md' },
        });
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
    expect(requested.some((url) => url.endsWith('/abc.md'))).toBe(true);
    expect(requested.some((url) => url.includes('/compat/chat/completions'))).toBe(true);
    // 保存済みファイルは、取得したshaでそのまま上書きする。
    expect(putSha).toBe('stored-sha');
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
