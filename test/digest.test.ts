import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBlocks, keepClipBlocks, runWeeklyDigest } from '../src/digest';
import type { ThreadAgent } from '../src/thread';
import { jsonResponse, makeEnv, resetClips } from './helpers';

interface Stub {
  namespace: DurableObjectNamespace<ThreadAgent>;
  names: string[];
  appended: string[];
}

function threadStub(): Stub {
  const stub: Stub = {
    names: [],
    appended: [],
    namespace: undefined as unknown as DurableObjectNamespace<ThreadAgent>,
  };
  stub.namespace = {
    idFromName: (name: string) => {
      stub.names.push(name);
      return 'thread-id';
    },
    get: () => ({
      append: async (messages: string[]) => void stub.appended.push(...messages),
    }),
  } as unknown as DurableObjectNamespace<ThreadAgent>;
  return stub;
}

interface SlackCalls {
  bodies: Record<string, Record<string, unknown>>;
}

function mockSlack(): SlackCalls {
  const calls: SlackCalls = { bodies: {} };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = String(input).replace('https://slack.com/api/', '');
    calls.bodies[method] = JSON.parse(String((init as RequestInit).body));
    if (method === 'conversations.open') {
      return jsonResponse({ ok: true, channel: { id: 'D123' } });
    }
    if (method === 'chat.postMessage') {
      return jsonResponse({ ok: true, ts: '1700000000.000100' });
    }
    throw new Error(`unexpected request: ${String(input)}`);
  });
  return calls;
}

/** 並び順が確定するよう、`clipped_at`は渡した順に古くする。 */
async function seed(paths: string[]): Promise<void> {
  for (const [index, path] of paths.entries()) {
    await testEnv.CLIPS.prepare('INSERT INTO clips (path, url, clipped_at) VALUES (?, ?, ?)')
      .bind(
        path,
        index === 0 ? null : `https://example.com/${index}`,
        `2026-08-${String(10 - index).padStart(2, '0')}T00:00:00.000Z`,
      )
      .run();
  }
}

beforeEach(resetClips);
afterEach(() => vi.restoreAllMocks());

describe('weekly digest', () => {
  it('posts one message to the DM and leaves the list in the thread', async () => {
    await seed(['clips/qiita.com/バックフィルの記事.md', 'clips/zenn.dev/保存した記事.md']);
    const slack = mockSlack();
    const thread = threadStub();

    await runWeeklyDigest(
      makeEnv({ THREAD: thread.namespace }),
      new Date('2026-08-16T00:00:00.000Z'),
    );

    // cronにはSlackのイベントが無いので、DMのチャンネルIDはconversations.openで引く。
    expect(slack.bodies['conversations.open']).toEqual({ users: 'U_ALLOWED' });

    const posted = slack.bodies['chat.postMessage'] as { channel: string; blocks: unknown[] };
    expect(posted.channel).toBe('D123');
    // 見出し1つと、クリップごとに1行。
    expect(posted.blocks).toHaveLength(3);
    expect(JSON.stringify(posted.blocks[0])).toContain('2件');
    // urlがNULLの行（バックフィル由来）はGitHubのファイルへリンクする。
    expect(JSON.stringify(posted.blocks[1])).toContain(
      'https://github.com/example/clips/blob/main/clips/qiita.com/',
    );
    expect(JSON.stringify(posted.blocks[2])).toContain('https://example.com/1');

    // スレッドの文脈に一覧が残るので、「2番目のやつ片付けて」をAIが解決できる。
    expect(thread.names).toEqual(['D123:1700000000.000100']);
    const turns = thread.appended.map(
      (message) => JSON.parse(message) as { role: string; content: string },
    );
    // 履歴は他のターンと同じく user から始める。
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.content).toContain('1. バックフィルの記事（clips/qiita.com/バックフィルの記事.md）');
    expect(turns[1]?.content).toContain('2. 保存した記事（clips/zenn.dev/保存した記事.md）');

    // 出した分にだけ提示済みの印が付く。
    const shown = await testEnv.CLIPS.prepare(
      'SELECT count(*) AS n FROM clips WHERE last_shown_at = ?',
    )
      .bind('2026-08-16T00:00:00.000Z')
      .first<{ n: number }>();
    expect(shown?.n).toBe(2);
  });

  it('does not mark clips as shown when the post fails', async () => {
    await seed(['clips/qiita.com/記事.md']);
    // cronは再試行されないので、先に印を打つと一度も出ないまま順番の後ろへ回る。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('conversations.open')) {
        return jsonResponse({ ok: false, error: 'missing_scope' });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    await expect(
      runWeeklyDigest(makeEnv({ THREAD: threadStub().namespace })),
    ).rejects.toThrow('missing_scope');

    const row = await testEnv.CLIPS.prepare('SELECT last_shown_at FROM clips')
      .first<{ last_shown_at: string | null }>();
    expect(row?.last_shown_at).toBeNull();
  });

  it('says so when nothing is waiting, instead of going silent', async () => {
    const slack = mockSlack();
    const thread = threadStub();

    await runWeeklyDigest(
      makeEnv({ THREAD: thread.namespace }),
      new Date('2026-08-16T00:00:00.000Z'),
    );

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect(posted.blocks).toHaveLength(1);
    expect(JSON.stringify(posted.blocks[0])).toContain('いまは残っていない');
    // 会話へ残す中身が無いので、スレッドは作らない。
    expect(thread.names).toEqual([]);
  });
});

describe('keepClipBlocks', () => {
  it('keeps only the rows that are still waiting and counts down the heading', () => {
    const blocks = digestBlocks(makeEnv(), [
      { path: 'clips/a.md', url: 'https://example.com/a' },
      { path: 'clips/b.md', url: 'https://example.com/b' },
    ]);

    const remaining = keepClipBlocks(blocks, new Set(['clips/b.md']));

    expect(remaining).toHaveLength(2);
    expect(JSON.stringify(remaining[0])).toContain('1件');
    expect(JSON.stringify(remaining[1])).toContain('clips/b.md');
    expect(JSON.stringify(remaining)).not.toContain('clips/a.md');
  });

  it('leaves only the heading when the last row goes', () => {
    const blocks = digestBlocks(makeEnv(), [{ path: 'clips/a.md', url: null }]);

    const remaining = keepClipBlocks(blocks, new Set());

    expect(remaining).toHaveLength(1);
    expect(JSON.stringify(remaining[0])).toContain('いまは残っていない');
  });

  it('escapes a pipe in the article URL so the link does not break', () => {
    const blocks = digestBlocks(makeEnv(), [
      { path: 'clips/example.com/記事.md', url: 'https://example.com/a?x=b|c' },
    ]);

    expect(JSON.stringify(blocks[1])).toContain('https://example.com/a?x=b%7Cc|記事');
  });
});
