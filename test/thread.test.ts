import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import type { ThreadAgent } from '../src/thread';

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

    await stub.save('Ev1', [greeting, answer], 'こんばんは。今日は何を読むの？', []);

    const next = await stub.load('Ev2');
    expect(next.history).toEqual([greeting, answer]);
    // 別のイベントなので、書き上げてある返信はない。
    expect(next.reply).toBeUndefined();
  });

  it('returns the stored reply for an event it already handled', async () => {
    const stub = thread('D123:redelivery');
    await stub.save('EvDup', [greeting, answer], '一度だけ答えるわ。', []);

    expect((await stub.load('EvDup')).reply).toBe('一度だけ答えるわ。');
  });

  it('keeps threads separate', async () => {
    await thread('D123:a').save('Ev1', [greeting], 'はじめまして。', []);

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

  it('stores a tool call and result as one expiring turn', async () => {
    const stub = thread('D123:turn-expiry-group');
    await stub.save('EvTurn', [greeting, answer], '保存したわ。', []);

    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ expires_at: string }>(
          'SELECT expires_at FROM turns ORDER BY seq',
        )
        .toArray(),
    );
    expect(new Set(rows.map((row) => row.expires_at)).size).toBe(1);
  });

  it('deletes expired turns, handled events, and saved reply clips from the alarm', async () => {
    const stub = thread('D123:retention-alarm');
    await stub.save('EvOld', [greeting, answer], '古い返信', [
      { path: 'clips/old.md', title: 'old' },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE turns SET expires_at = '2000-01-01T00:00:00.000Z'",
      );
      state.storage.sql.exec(
        "UPDATE handled SET expires_at = '2000-01-01T00:00:00.000Z'",
      );
    });

    await runInDurableObject(stub, (instance) => (instance as ThreadAgent).alarm());
    expect(await stub.load('EvOld')).toEqual({ history: [], saved: [] });
  });
});
