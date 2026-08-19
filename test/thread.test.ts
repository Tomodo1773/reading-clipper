import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';

const testEnv = env as unknown as Env;

function thread(name: string) {
  return testEnv.THREAD.get(testEnv.THREAD.idFromName(name));
}

const greeting = JSON.stringify({ role: 'user', content: 'こんばんは' });
const answer = JSON.stringify({ role: 'assistant', content: 'こんばんは。今日は何を読むの？' });

describe('ThreadAgent', () => {
  it('carries a saved turn into the next load', async () => {
    const stub = thread('D123:turn-carry');
    expect(await stub.load('Ev1')).toEqual({ history: [], saved: [] });

    await stub.save('Ev1', [greeting, answer], 'こんばんは。今日は何を読むの？');

    const next = await stub.load('Ev2');
    expect(next.history).toEqual([greeting, answer]);
    // 別のイベントなので、書き上げてある返信はない。
    expect(next.reply).toBeUndefined();
  });

  it('returns the stored reply for an event it already handled', async () => {
    const stub = thread('D123:redelivery');
    await stub.save('EvDup', [greeting, answer], '一度だけ答えるわ。');

    expect((await stub.load('EvDup')).reply).toBe('一度だけ答えるわ。');
  });

  it('keeps threads separate', async () => {
    await thread('D123:a').save('Ev1', [greeting], 'はじめまして。');

    expect(await thread('D123:b').load('Ev1')).toEqual({ history: [], saved: [] });
  });

  /**
   * 再送では返信を投げ直すだけでモデルを動かさないので、ボタンの材料もここに無いと落ちる
   * （ADR 0015）。
   */
  it('returns the clips saved in the turn it already handled', async () => {
    const stub = thread('D123:saved-clips');
    const clip = { path: 'clips/Worker設計.md', title: 'Worker設計' };

    await stub.save('EvSaved', [greeting, answer], '保存しておいたわ。', [clip]);

    expect((await stub.load('EvSaved')).saved).toEqual([clip]);
    // 保存が起きたのはそのターンだけ。別のイベントには付いてこない。
    expect((await stub.load('EvOther')).saved).toEqual([]);
  });
});
