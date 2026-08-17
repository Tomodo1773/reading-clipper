import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleQueueMessage } from '../src/processor';
import type { ThreadAgent } from '../src/thread';
import type { ChatJob } from '../src/types';
import { jsonResponse, makeEnv, modelResponse } from './helpers';

const job: ChatJob = {
  version: 2,
  jobId: 'EvProcess',
  text: 'https://qiita.com/alice/items/abc',
  slackChannel: 'D123',
  slackThreadTs: '1700000000.000100',
  receivedAt: '2026-08-15T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

interface Stub {
  namespace: DurableObjectNamespace<ThreadAgent>;
  names: string[];
  saved: { appended: string[]; reply: string }[];
}

/** 会話の置き場だけを差し替える。モデルの呼び出しはprocessor側で走る。 */
function threadStub(stored: { history?: string[]; reply?: string } = {}): Stub {
  const stub: Stub = {
    names: [],
    saved: [],
    namespace: undefined as unknown as DurableObjectNamespace<ThreadAgent>,
  };
  stub.namespace = {
    idFromName: (name: string) => {
      stub.names.push(name);
      return 'thread-id';
    },
    get: () => ({
      load: async () => ({ history: stored.history ?? [], reply: stored.reply }),
      save: async (_eventId: string, appended: string[], reply: string) => {
        stub.saved.push({ appended, reply });
      },
    }),
  } as unknown as DurableObjectNamespace<ThreadAgent>;
  return stub;
}

function queueMessage(overrides: Partial<{ body: ChatJob; attempts: number }> = {}) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    message: {
      body: overrides.body ?? job,
      attempts: overrides.attempts ?? 1,
      ack,
      retry,
    } as unknown as Message<ChatJob>,
  };
}

describe('queue handler', () => {
  it('acks a permanently invalid message after notifying Slack', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true, ts: '1700000000.000200' }));
    const { ack, retry, message } = queueMessage({
      body: { ...job, version: 1 } as unknown as ChatJob,
    });

    await handleQueueMessage(message, makeEnv());

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('runs the turn against the thread keyed by channel and thread_ts', async () => {
    const slackTexts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes(':generateContent')) {
        return modelResponse([{ text: 'こんばんは。今日は何を読むの？' }]);
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        slackTexts.push(JSON.parse(String(init?.body)).text);
        return jsonResponse({ ok: true, ts: '1700000000.000200' });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const thread = threadStub();
    const { ack, message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    expect(thread.names).toEqual(['D123:1700000000.000100']);
    expect(slackTexts).toEqual(['こんばんは。今日は何を読むの？']);
    // user と assistant の2件が、JSONのまま会話へ積まれる。
    expect(thread.saved).toHaveLength(1);
    expect(
      (thread.saved[0]?.appended ?? []).map((message) => JSON.parse(message).role),
    ).toEqual(['user', 'assistant']);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('reposts the stored reply for a redelivered event without calling the model', async () => {
    const slackTexts: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== 'https://slack.com/api/chat.postMessage') {
        throw new Error(`unexpected request: ${String(input)}`);
      }
      slackTexts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ ok: true, ts: '1700000000.000200' });
    });
    const thread = threadStub({ reply: '一度だけ答えるわ。' });
    const { ack, message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    expect(slackTexts).toEqual(['一度だけ答えるわ。']);
    expect(thread.saved).toEqual([]);
    expect(ack).toHaveBeenCalledOnce();
  });

  /**
   * 503はAI SDKが2秒→4秒で2回再試行してから投げてくる（ADR 0008）。
   * 既定の5秒では足りないので、この2件だけタイムアウトを延ばす。
   */
  const RETRY_TIMEOUT_MS = 20_000;

  it('notifies and retries a transient final failure so Cloudflare can move it to the DLQ', async () => {
    let slackNotified = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://slack.com/api/chat.postMessage') {
        slackNotified = true;
        return jsonResponse({ ok: true, ts: '1700000000.000200' });
      }
      return jsonResponse({ error: { message: 'gateway is unhappy' } }, 503);
    });
    const thread = threadStub();
    const { ack, retry, message } = queueMessage({ attempts: 4 });

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    expect(slackNotified).toBe(true);
    expect(thread.saved).toEqual([]);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  }, RETRY_TIMEOUT_MS);

  it('keeps retrying quietly while attempts remain', async () => {
    let slackNotified = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://slack.com/api/chat.postMessage') {
        slackNotified = true;
        return jsonResponse({ ok: true, ts: '1700000000.000200' });
      }
      return jsonResponse({ error: { message: 'gateway is unhappy' } }, 503);
    });
    const thread = threadStub();
    const { retry, message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    expect(retry).toHaveBeenCalledOnce();
    expect(slackNotified).toBe(false);
  }, RETRY_TIMEOUT_MS);
});
