import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipError } from '../src/errors';
import { handleQueueMessage } from '../src/processor';
import type { ThreadAgent } from '../src/thread';
import type { ChatJob } from '../src/types';
import { jsonResponse, makeEnv } from './helpers';

const job: ChatJob = {
  version: 2,
  jobId: 'EvProcess',
  text: 'https://qiita.com/alice/items/abc',
  slackChannel: 'D123',
  slackThreadTs: '1700000000.000100',
  receivedAt: '2026-08-15T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

function threadStub(handle: () => Promise<void>): DurableObjectNamespace<ThreadAgent> {
  return {
    idFromName: () => 'thread-id',
    get: () => ({ handle }),
  } as unknown as DurableObjectNamespace<ThreadAgent>;
}

describe('queue handler', () => {
  it('acks a permanently invalid message after notifying Slack', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      body: { ...job, version: 1 },
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<ChatJob>;

    await handleQueueMessage(message, makeEnv());

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('hands a valid message to the thread keyed by channel and thread_ts', async () => {
    const handle = vi.fn(async () => undefined);
    const seen: string[] = [];
    const namespace = {
      idFromName: (name: string) => {
        seen.push(name);
        return 'thread-id';
      },
      get: () => ({ handle }),
    } as unknown as DurableObjectNamespace<ThreadAgent>;
    const ack = vi.fn();
    const message = { body: job, attempts: 1, ack, retry: vi.fn() } as unknown as Message<ChatJob>;

    await handleQueueMessage(message, makeEnv({ THREAD: namespace }));

    expect(seen).toEqual(['D123:1700000000.000100']);
    expect(handle).toHaveBeenCalledWith(job);
    expect(ack).toHaveBeenCalledOnce();
  });

  it('notifies and retries a transient final failure so Cloudflare can move it to the DLQ', async () => {
    let slackNotified = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === 'https://slack.com/api/chat.postMessage') {
        slackNotified = true;
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const namespace = threadStub(async () => {
      throw new ClipError('gateway is unhappy', 'chat', true, 503);
    });
    const ack = vi.fn();
    const retry = vi.fn();
    const message = { body: job, attempts: 4, ack, retry } as unknown as Message<ChatJob>;

    await handleQueueMessage(message, makeEnv({ THREAD: namespace }));

    expect(slackNotified).toBe(true);
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps retrying quietly while attempts remain', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    const namespace = threadStub(async () => {
      throw new ClipError('gateway is unhappy', 'chat', true, 503);
    });
    const retry = vi.fn();
    const message = { body: job, attempts: 1, ack: vi.fn(), retry } as unknown as Message<ChatJob>;

    await handleQueueMessage(message, makeEnv({ THREAD: namespace }));

    expect(retry).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
