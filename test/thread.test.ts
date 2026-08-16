import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadAgent } from '../src/thread';
import type { ChatJob, Env } from '../src/types';
import { jsonResponse, modelResponse } from './helpers';

const testEnv = env as unknown as Env;

afterEach(() => vi.restoreAllMocks());

function job(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    version: 2,
    jobId: 'Ev1',
    text: 'こんばんは',
    slackChannel: 'D123',
    slackThreadTs: '1700000000.000100',
    receivedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

interface Recorded {
  modelBodies: Record<string, unknown>[];
  slackTexts: string[];
}

function mockModel(replies: string[]): Recorded {
  const recorded: Recorded = { modelBodies: [], slackTexts: [] };
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/compat/chat/completions')) {
      recorded.modelBodies.push(JSON.parse(String(init?.body)));
      const reply = replies[call];
      call += 1;
      if (reply === undefined) throw new Error(`unexpected model call #${call}`);
      return modelResponse({ content: reply });
    }
    if (url === 'https://slack.com/api/chat.postMessage') {
      recorded.slackTexts.push(JSON.parse(String(init?.body)).text);
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return recorded;
}

function thread(name: string) {
  return testEnv.THREAD.get(testEnv.THREAD.idFromName(name));
}

describe('ThreadAgent', () => {
  it('replies and carries the conversation into the next turn', async () => {
    const recorded = mockModel(['こんばんは。今日は何を読むの？', 'さっきの挨拶ね。覚えているわよ。']);
    const stub = thread('D123:turn-carry');

    await runInDurableObject(stub, (instance) => (instance as unknown as ThreadAgent).handle(job()));
    await runInDurableObject(stub, (instance) => (instance as unknown as ThreadAgent).handle(job({ jobId: 'Ev2', text: 'さっき何て言った？' })),
    );

    expect(recorded.slackTexts).toEqual([
      'こんばんは。今日は何を読むの？',
      'さっきの挨拶ね。覚えているわよ。',
    ]);

    // 2ターン目は1ターン目のやり取りを含めて送る（systemを除いて user/assistant/user）。
    const second = recorded.modelBodies[1]?.messages as Array<{ role: string; content: string }>;
    expect(second.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(second[1]?.content).toBe('こんばんは');
    expect(second[2]?.content).toBe('こんばんは。今日は何を読むの？');
  });

  it('does not run the model twice for a redelivered event', async () => {
    const recorded = mockModel(['一度だけ答えるわ。']);
    const stub = thread('D123:redelivery');

    await runInDurableObject(stub, (instance) => (instance as unknown as ThreadAgent).handle(job({ jobId: 'EvDup' })));
    await runInDurableObject(stub, (instance) => (instance as unknown as ThreadAgent).handle(job({ jobId: 'EvDup' })));

    expect(recorded.modelBodies).toHaveLength(1);
    // 保存済みの返信でSlackへの投稿だけをやり直す。
    expect(recorded.slackTexts).toEqual(['一度だけ答えるわ。', '一度だけ答えるわ。']);
  });

  it('keeps threads separate', async () => {
    const recorded = mockModel(['はじめまして。', 'こちらもはじめまして。']);

    await runInDurableObject(thread('D123:a'), (instance) => (instance as unknown as ThreadAgent).handle(job()));
    await runInDurableObject(thread('D123:b'), (instance) => (instance as unknown as ThreadAgent).handle(job({ jobId: 'Ev2' })),
    );

    const second = recorded.modelBodies[1]?.messages as Array<{ role: string }>;
    expect(second.map((message) => message.role)).toEqual(['system', 'user']);
  });

  it('persists nothing when the turn fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 503));
    const stub = thread('D123:failure');

    const outcome = await runInDurableObject(stub, (instance) =>
      (instance as unknown as ThreadAgent).handle(job({ jobId: 'EvFail' })),
    );
    expect(outcome).toMatchObject({ ok: false, stage: 'chat', status: 503 });

    const recorded = mockModel(['やり直したわ。']);
    await runInDurableObject(stub, (instance) => (instance as unknown as ThreadAgent).handle(job({ jobId: 'EvFail' })));

    // 失敗したターンは履歴に残っていないので、systemとuserだけで再実行される。
    const messages = recorded.modelBodies[0]?.messages as Array<{ role: string }>;
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
  });
});
