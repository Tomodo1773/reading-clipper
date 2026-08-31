import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordClip } from '../src/clips';
import { resetGitHubTokenCache } from '../src/github';
import worker from '../src/index';
import { handleTranslateMessage, queueTranslation, splitForTranslation } from '../src/translate';
import type { Env, TranslateJob } from '../src/types';
import { base64ToUtf8, utf8ToBase64 } from '../src/utils';
import {
  generatePrivateKeyPem,
  jsonResponse,
  makeEnv,
  modelResponse,
  resetClips,
} from './helpers';

const CLIP_PATH = 'clips/Deep Dive.md';
const CLIP_SHA = 'sha-saved';
const CLIP_FILE = [
  '---',
  'source_url: "https://example.com/post"',
  'source_type: "web"',
  'title: "Deep Dive"',
  'clipped_at: "2026-08-20T00:00:00.000Z"',
  'fetch_complete: true',
  '---',
  '',
  '# Deep Dive',
  '',
  'Queues decouple slow work from the reply.',
  '',
].join('\n');

const TRANSLATED = '# 詳解\n\n待ち行列は重い処理を返信から切り離す。';

let privateKeyPem: string;

beforeEach(async () => {
  resetGitHubTokenCache();
  await resetClips();
  privateKeyPem = await generatePrivateKeyPem();
});

/** GitHubのインストールトークンを取るところまで実物を通すので、鍵は本物を渡す。 */
function translateEnv(): Env {
  return makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem });
}

afterEach(() => vi.restoreAllMocks());

interface Recorded {
  modelCalls: number;
  savedMarkdown: string;
  savedSha: string;
}

/**
 * GitHubの1ファイルとモデルだけを差し替える。フロントマターの読み書きも新着一覧の
 * 作り直しも実物のコードを通す。
 */
function mockWorld(
  file: { content: string; sha: string } | undefined,
  modelReplies: Response[],
): Recorded {
  const recorded: Recorded = {
    modelCalls: 0,
    savedMarkdown: '',
    savedSha: '',
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/app/installations/') && method === 'POST') {
      return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
    }
    if (url.includes(':generateContent')) {
      const reply = modelReplies[recorded.modelCalls];
      recorded.modelCalls += 1;
      if (!reply) throw new Error(`unexpected model call #${recorded.modelCalls}`);
      return reply;
    }
    if (url.includes('/contents/') && method === 'GET') {
      const path = decodeURIComponent(url.split('/contents/')[1] ?? '');
      if (path === CLIP_PATH && file) {
        return jsonResponse({
          sha: file.sha,
          html_url: 'https://github.com/example/clips/blob/main/clip.md',
          encoding: 'base64',
          content: utf8ToBase64(file.content),
        });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url.includes('/contents/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body));
      recorded.savedMarkdown = base64ToUtf8(body.content);
      recorded.savedSha = body.sha ?? '';
      return jsonResponse(
        {
          content: {
            sha: 'sha-translated',
            html_url: 'https://github.com/example/clips/blob/main/clip.md',
          },
        },
        200,
      );
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return recorded;
}

interface Delivered {
  message: Message<TranslateJob>;
  acked: number;
  retried: number;
}

function deliver(job: unknown, attempts = 1): Delivered {
  const delivered: Delivered = { message: undefined as never, acked: 0, retried: 0 };
  delivered.message = {
    body: job,
    attempts,
    ack: () => {
      delivered.acked += 1;
    },
    retry: () => {
      delivered.retried += 1;
    },
  } as unknown as Message<TranslateJob>;
  return delivered;
}

function envWithQueue(sent: TranslateJob[]): Env {
  return makeEnv({
    TRANSLATE_QUEUE: {
      send: async (job: TranslateJob) => {
        sent.push(job);
      },
    } as unknown as Queue<TranslateJob>,
  });
}

describe('translation queueing', () => {
  async function queueFor(bodyLanguage: string | undefined): Promise<TranslateJob[]> {
    const sent: TranslateJob[] = [];
    await queueTranslation(envWithQueue(sent), { path: CLIP_PATH, sha: CLIP_SHA }, bodyLanguage);
    return sent;
  }

  it('queues the saved path and sha for a non-Japanese body', async () => {
    expect(await queueFor('en')).toEqual([{ version: 1, path: CLIP_PATH, sha: CLIP_SHA }]);
    expect(await queueFor('English')).toHaveLength(1);
    expect(await queueFor('fr')).toHaveLength(1);
  });

  it('queues nothing for a Japanese body, or when the model said nothing', async () => {
    expect(await queueFor('ja')).toEqual([]);
    expect(await queueFor('ja-JP')).toEqual([]);
    expect(await queueFor('Japanese')).toEqual([]);
    // 言語が渡らなかったときは訳さない。コード側で当てにいかない（ADR 0027）。
    expect(await queueFor(undefined)).toEqual([]);
    expect(await queueFor('  ')).toEqual([]);
  });
});

describe('splitting for translation', () => {
  it('keeps an ordinary article in one piece', () => {
    const article = '# Title\n\nQueues decouple slow work.\n\n## Detail\n\nThe reply stays fast.';
    expect(splitForTranslation(article)).toEqual([article]);
  });

  it('splits a long body at boundaries and keeps every piece under the limit', () => {
    const body = Array.from(
      { length: 40 },
      (_, index) => `## Section ${index}\n\n${'word '.repeat(200)}`,
    ).join('\n\n');
    const chunks = splitForTranslation(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20_000);
    // 落とさず、順序も変えない。
    expect(chunks.join('\n\n').replace(/\s+/g, ' ').trim()).toBe(
      body.replace(/\s+/g, ' ').trim(),
    );
  });

  it('never splits inside a fenced code block', () => {
    const code = `\`\`\`ts\n${'const x = 1;\n'.repeat(900)}\`\`\``;
    const body = `## Before\n\n${'word '.repeat(2000)}\n\n${code}\n\n## After\n\nDone.`;
    const chunks = splitForTranslation(body);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
  });
});

describe('queue routing', () => {
  function batch(queue: string, message: Message<TranslateJob>): MessageBatch<TranslateJob> {
    return {
      queue,
      messages: [message],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<TranslateJob>;
  }

  it('sends the translation queue to the translator', async () => {
    const recorded = mockWorld({ content: CLIP_FILE, sha: CLIP_SHA }, [
      modelResponse([{ text: TRANSLATED }]),
    ]);
    const delivered = deliver({ version: 1, path: CLIP_PATH, sha: CLIP_SHA });

    await worker.queue(
      batch('reading-clipper-translations', delivered.message),
      translateEnv(),
    );

    expect(recorded.modelCalls).toBe(1);
    expect(recorded.savedMarkdown).toContain('translated_at: "');
  });

  it('leaves the conversation queue with the conversation handler', async () => {
    const recorded = mockWorld(undefined, []);
    // 会話のジョブ。翻訳側へ流れると、この形は不正な札として捨てられてしまう。
    const delivered = deliver({
      version: 2,
      jobId: 'EvRouting',
      text: 'https://example.com/post',
      slackChannel: 'D123',
      slackThreadTs: '1700000000.000100',
      receivedAt: '2026-08-20T00:00:00.000Z',
    });

    await worker.queue(batch('reading-clipper-clips', delivered.message), translateEnv());

    // 会話側はスレッドの置き場を引きにいく（makeEnvでは投げる）。翻訳は動いていない。
    expect(recorded.modelCalls).toBe(0);
    expect(recorded.savedMarkdown).toBe('');
    expect(delivered.retried).toBe(1);
    expect(delivered.acked).toBe(0);
  });
});

describe('translating a saved clip', () => {
  it('replaces the body, keeps the front matter, and refreshes the excerpt', async () => {
    await recordClip(testEnv as unknown as Env, {
      path: CLIP_PATH,
      url: 'https://example.com/post',
      title: 'Deep Dive',
      excerpt: 'Queues decouple slow work from the reply.',
      clippedAt: '2026-08-20T00:00:00.000Z',
    });
    const recorded = mockWorld({ content: CLIP_FILE, sha: CLIP_SHA }, [
      modelResponse([{ text: TRANSLATED }]),
    ]);
    const delivered = deliver({ version: 1, path: CLIP_PATH, sha: CLIP_SHA });

    await handleTranslateMessage(delivered.message, translateEnv());

    expect(recorded.modelCalls).toBe(1);
    // 読んだときのSHAで書き戻す。ファイル名も題名も変えない。
    expect(recorded.savedSha).toBe(CLIP_SHA);
    expect(recorded.savedMarkdown).toContain('title: "Deep Dive"');
    expect(recorded.savedMarkdown).toContain('source_url: "https://example.com/post"');
    expect(recorded.savedMarkdown).toContain('fetch_complete: true');
    expect(recorded.savedMarkdown).toContain('translated_at: "');
    expect(recorded.savedMarkdown).toContain('待ち行列は重い処理を返信から切り離す。');
    expect(recorded.savedMarkdown).not.toContain('Queues decouple slow work from the reply.');

    // 一覧に出る抜粋だけを訳文から作り直す。題名は原題のまま（ADR 0027）。
    const row = await testEnv.CLIPS.prepare(
      'SELECT title, excerpt FROM clips WHERE path = ?',
    )
      .bind(CLIP_PATH)
      .first<{ title: string; excerpt: string }>();
    expect(row?.title).toBe('Deep Dive');
    expect(row?.excerpt).toContain('待ち行列');

    expect(delivered.acked).toBe(1);
    expect(delivered.retried).toBe(0);
  });

  it('does nothing when another save landed after the job was queued', async () => {
    const recorded = mockWorld({ content: CLIP_FILE, sha: 'sha-newer' }, []);
    const delivered = deliver({ version: 1, path: CLIP_PATH, sha: CLIP_SHA });

    await handleTranslateMessage(delivered.message, translateEnv());

    expect(recorded.modelCalls).toBe(0);
    expect(recorded.savedMarkdown).toBe('');
    expect(delivered.acked).toBe(1);
  });

  it('does nothing when the clip is already translated', async () => {
    const translated = CLIP_FILE.replace(
      'fetch_complete: true',
      'fetch_complete: true\ntranslated_at: "2026-08-21T00:00:00.000Z"',
    );
    const recorded = mockWorld({ content: translated, sha: CLIP_SHA }, []);
    const delivered = deliver({ version: 1, path: CLIP_PATH, sha: CLIP_SHA });

    await handleTranslateMessage(delivered.message, translateEnv());

    expect(recorded.modelCalls).toBe(0);
    expect(recorded.savedMarkdown).toBe('');
    expect(delivered.acked).toBe(1);
  });

  it('saves nothing and gives up when the model output was cut off by its limit', async () => {
    const recorded = mockWorld({ content: CLIP_FILE, sha: CLIP_SHA }, [
      modelResponse([{ text: '# 詳解\n\n待ち行列は' }], { finishReason: 'MAX_TOKENS' }),
    ]);
    const delivered = deliver({ version: 1, path: CLIP_PATH, sha: CLIP_SHA });

    await handleTranslateMessage(delivered.message, translateEnv());

    // 半端な訳文は保存しない。投げ直しても同じ場所で切れるので再試行もしない（ADR 0027）。
    expect(recorded.savedMarkdown).toBe('');
    expect(delivered.retried).toBe(0);
    expect(delivered.acked).toBe(1);
  });

  it('drops a job that does not point at a clip', async () => {
    const recorded = mockWorld(undefined, []);
    const delivered = deliver({ version: 1, path: 'README.md', sha: CLIP_SHA });

    await handleTranslateMessage(delivered.message, translateEnv());

    expect(recorded.modelCalls).toBe(0);
    expect(delivered.acked).toBe(1);
    expect(delivered.retried).toBe(0);
  });
});
