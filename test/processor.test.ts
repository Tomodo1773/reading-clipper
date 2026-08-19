import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleQueueMessage } from '../src/processor';
import type { ThreadAgent } from '../src/thread';
import type { ChatJob, SavedClip } from '../src/types';
import { jsonResponse, makeEnv, modelResponse, readSlackCall } from './helpers';

const job: ChatJob = {
  version: 2,
  jobId: 'EvProcess',
  text: 'https://qiita.com/alice/items/abc',
  slackChannel: 'D123',
  slackThreadTs: '1700000000.000100',
  receivedAt: '2026-08-15T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

const CLIP: SavedClip = { path: 'clips/Worker設計.md', title: 'Worker設計' };

interface Post {
  text: string;
  blocks: unknown[] | undefined;
}

/**
 * `chat.postMessage`だけを受ける。`routes`がundefinedを返した要求は想定外として投げる。
 */
function mockSlackPosts(routes: (input: RequestInfo | URL) => Response | undefined = () => undefined): Post[] {
  const posts: Post[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const call = await readSlackCall(input);
    if (call?.method === 'chat.postMessage') {
      posts.push({
        text: String(call.params.text),
        blocks: call.params.blocks as unknown[] | undefined,
      });
      return jsonResponse({ ok: true, ts: '1700000000.000200' });
    }
    const routed = routes(input);
    if (routed) return routed;
    throw new Error(`unexpected request: ${String(input)}`);
  });
  return posts;
}

interface Stub {
  namespace: DurableObjectNamespace<ThreadAgent>;
  names: string[];
  saved: { appended: string[]; reply: string; clips: SavedClip[] }[];
}

/** 会話の置き場だけを差し替える。モデルの呼び出しはprocessor側で走る。 */
function threadStub(
  stored: { history?: string[]; reply?: string; saved?: SavedClip[] } = {},
): Stub {
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
      load: async () => ({
        history: stored.history ?? [],
        reply: stored.reply,
        saved: stored.saved ?? [],
      }),
      save: async (_eventId: string, appended: string[], reply: string, clips: SavedClip[]) => {
        stub.saved.push({ appended, reply, clips });
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
    const posts = mockSlackPosts((input) =>
      String(input).includes(':generateContent')
        ? modelResponse([{ text: 'こんばんは。今日は何を読むの？' }])
        : undefined,
    );
    const thread = threadStub();
    const { ack, message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    expect(thread.names).toEqual(['D123:1700000000.000100']);
    expect(posts.map((post) => post.text)).toEqual(['こんばんは。今日は何を読むの？']);
    // 保存の無いターンなので、ボタンもblocksも付かない（ADR 0015）。
    expect(posts[0]?.blocks).toBeUndefined();
    // user と assistant の2件が、JSONのまま会話へ積まれる。
    expect(thread.saved).toHaveLength(1);
    expect(
      (thread.saved[0]?.appended ?? []).map((message) => JSON.parse(message).role),
    ).toEqual(['user', 'assistant']);
    expect(thread.saved[0]?.clips).toEqual([]);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('posts a dismiss button on the reply that saved a clip', async () => {
    const posts = mockSlackPosts();
    // 保存が起きたターンかどうかは、返信の文面ではなくツールの実行結果で決まる（ADR 0015）。
    const thread = threadStub({ reply: '保存しておいたわ。', saved: [CLIP] });
    const { message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    // 通知に出る文は今までどおり返信そのもの。本文はsectionが持つ。
    expect(posts[0]?.text).toBe('保存しておいたわ。');
    expect(posts[0]?.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '保存しておいたわ。' } },
      {
        type: 'actions',
        block_id: 'dismiss-0',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '片付ける' },
            action_id: 'dismiss_thread_clip',
            value: CLIP.path,
          },
        ],
      },
    ]);
  });

  it('reposts the stored reply for a redelivered event without calling the model', async () => {
    const posts = mockSlackPosts();
    const thread = threadStub({ reply: '一度だけ答えるわ。' });
    const { ack, message } = queueMessage();

    await handleQueueMessage(message, makeEnv({ THREAD: thread.namespace }));

    // Queuesはat-least-onceで、ackの前に落ちれば同じジョブがもう一度届く。
    // 守るのはモデルを二度呼ばないことと、返信の中身が変わらないことまで。
    // 投稿そのものの重複排除はしない（ADR 0014）。
    expect(posts.map((post) => post.text)).toEqual(['一度だけ答えるわ。']);
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
      if ((await readSlackCall(input))?.method === 'chat.postMessage') {
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
      if ((await readSlackCall(input))?.method === 'chat.postMessage') {
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
