import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestClip } from '../src/clips';
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
  imageRequests: string[];
}

function imageResponse(contentType = 'image/png'): Response {
  return new Response('binary', { headers: { 'content-type': contentType } });
}

/**
 * `https://img.example.com/` は取得できる画像、`https://gone.example.com/` は404を返す。
 * サムネイルの検証がここを通るので、Slack以外のリクエストも受け付ける必要がある。
 */
function mockSlack(): SlackCalls {
  const calls: SlackCalls = { bodies: {}, imageRequests: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://img.example.com/')) {
      calls.imageRequests.push(url);
      return imageResponse();
    }
    if (url.startsWith('https://gone.example.com/')) {
      calls.imageRequests.push(url);
      return new Response('not found', { status: 404 });
    }
    if (url.startsWith('https://html.example.com/')) {
      calls.imageRequests.push(url);
      return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    }
    const method = url.replace('https://slack.com/api/', '');
    calls.bodies[method] = JSON.parse(String((init as RequestInit).body));
    if (method === 'conversations.open') {
      return jsonResponse({ ok: true, channel: { id: 'D123' } });
    }
    if (method === 'chat.postMessage') {
      return jsonResponse({ ok: true, ts: '1700000000.000100' });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return calls;
}

interface SeedClip {
  path: string;
  url?: string | null;
  title?: string | null;
  excerpt?: string | null;
  imageUrl?: string | null;
}

/** 並び順が確定するよう、`clipped_at`は渡した順に古くする。 */
async function seed(clips: SeedClip[]): Promise<void> {
  for (const [index, clip] of clips.entries()) {
    await testEnv.CLIPS.prepare(
      `INSERT INTO clips (path, url, title, excerpt, image_url, clipped_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        clip.path,
        clip.url ?? null,
        clip.title ?? null,
        clip.excerpt ?? null,
        clip.imageUrl ?? null,
        `2026-08-${String(10 - index).padStart(2, '0')}T00:00:00.000Z`,
      )
      .run();
  }
}

function digestClip(overrides: Partial<DigestClip> & { path: string }): DigestClip {
  return {
    url: null,
    title: null,
    excerpt: null,
    imageUrl: null,
    clippedAt: '2026-02-03T00:00:00.000Z',
    ...overrides,
  };
}

/** `block_id`が`clip-N`で始まるブロックを、1件ぶんの組ごとに集める。 */
function groupsOf(blocks: unknown[]): Record<string, Record<string, unknown>[]> {
  const groups: Record<string, Record<string, unknown>[]> = {};
  for (const block of blocks as Record<string, unknown>[]) {
    const id = String(block.block_id ?? '').match(/^(clip-\d+)/)?.[1];
    if (!id) continue;
    (groups[id] ??= []).push(block);
  }
  return groups;
}

beforeEach(resetClips);
afterEach(() => vi.restoreAllMocks());

describe('weekly digest', () => {
  it('posts one message to the DM and leaves the list in the thread', async () => {
    await seed([
      { path: 'clips/qiita.com/バックフィルの記事.md' },
      {
        path: 'clips/zenn.dev/ファイル名.md',
        url: 'https://example.com/1',
        title: '保存した記事',
        excerpt: '本文の書き出しがここに入る。',
        imageUrl: 'https://img.example.com/1.png',
      },
    ]);
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
    // 見出しと区切り、そのあとクリップごとに section + actions + context の3ブロック。
    expect(posted.blocks).toHaveLength(8);
    expect(JSON.stringify(posted.blocks[0])).toContain('2件');

    const groups = groupsOf(posted.blocks);
    expect(Object.keys(groups)).toEqual(['clip-0', 'clip-1']);
    // urlがNULLの行（バックフィル由来）はGitHubのファイルへリンクする。
    expect(JSON.stringify(groups['clip-0'])).toContain(
      'https://github.com/example/clips/blob/main/clips/qiita.com/',
    );
    // タイトルが列にあればそれを使う。パス末尾はファイル名として削られている。
    expect(JSON.stringify(groups['clip-1'])).toContain('保存した記事');
    expect(JSON.stringify(groups['clip-1'])).toContain('本文の書き出しがここに入る。');
    expect(JSON.stringify(groups['clip-1'])).toContain('https://example.com/1');
    // メタ行にはホストと保存時期を出す。ホストはパスから取る。
    // mrkdwnにするとSlackが`<http://zenn.dev|zenn.dev>`へ変えてしまうのでplain_textで出す。
    const meta = groups['clip-1']?.[2] as { type: string; elements: { type: string; text: string }[] };
    expect(meta.type).toBe('context');
    expect(meta.elements[0]).toEqual({ type: 'plain_text', text: 'zenn.dev ・ 2026年8月に保存' });

    // スレッドの文脈に一覧が残るので、「2番目のやつ片付けて」をAIが解決できる。
    expect(thread.names).toEqual(['D123:1700000000.000100']);
    const turns = thread.appended.map(
      (message) => JSON.parse(message) as { role: string; content: string },
    );
    // 履歴は他のターンと同じく user から始める。
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.content).toContain('1. バックフィルの記事（clips/qiita.com/バックフィルの記事.md）');
    expect(turns[1]?.content).toContain('2. 保存した記事（clips/zenn.dev/ファイル名.md）');

    // 出した分にだけ提示済みの印が付く。
    const shown = await testEnv.CLIPS.prepare(
      'SELECT count(*) AS n FROM clips WHERE last_shown_at = ?',
    )
      .bind('2026-08-16T00:00:00.000Z')
      .first<{ n: number }>();
    expect(shown?.n).toBe(2);
  });

  it('shows the thumbnail as the section accessory', async () => {
    await seed([
      { path: 'clips/zenn.dev/記事.md', url: 'https://example.com/1', imageUrl: 'https://img.example.com/1.png' },
    ]);
    const slack = mockSlack();

    await runWeeklyDigest(makeEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    const section = groupsOf(posted.blocks)['clip-0']?.[0] as { accessory?: Record<string, unknown> };
    expect(section.accessory).toMatchObject({
      type: 'image',
      image_url: 'https://img.example.com/1.png',
    });
    // ボタンはaccessoryを画像に譲るので、actionsブロックへ出る。
    const actions = groupsOf(posted.blocks)['clip-0']?.[1] as { type: string; elements: unknown[] };
    expect(actions.type).toBe('actions');
    expect(JSON.stringify(actions.elements)).toContain('dismiss_clip');
  });

  it('drops an unreachable thumbnail but still posts the digest', async () => {
    // Slackは取得できないimage_urlを渡すとメッセージ全体を拒否する。渡す前に落とす。
    await seed([
      { path: 'clips/a.com/生きている.md', url: 'https://example.com/1', imageUrl: 'https://img.example.com/1.png' },
      { path: 'clips/b.com/消えた.md', url: 'https://example.com/2', imageUrl: 'https://gone.example.com/2.png' },
      { path: 'clips/c.com/画像でない.md', url: 'https://example.com/3', imageUrl: 'https://html.example.com/3' },
    ]);
    const slack = mockSlack();

    await runWeeklyDigest(makeEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    const groups = groupsOf(posted.blocks);
    expect((groups['clip-0']?.[0] as { accessory?: unknown }).accessory).toBeDefined();
    // 404も、200だが画像でないものも捨てる。
    expect((groups['clip-1']?.[0] as { accessory?: unknown }).accessory).toBeUndefined();
    expect((groups['clip-2']?.[0] as { accessory?: unknown }).accessory).toBeUndefined();
    // 3件とも行そのものは残り、投稿も提示済みの印も通常どおり行われる。
    expect(Object.keys(groups)).toHaveLength(3);
  });

  it('drops a thumbnail whose URL is longer than Slack accepts', async () => {
    // Qiitaの自動生成OGPは2600文字を超える。上限の3000を越えると投稿ごと弾かれる。
    const tooLong = `https://img.example.com/${'a'.repeat(3000)}.png`;
    await seed([{ path: 'clips/a.com/記事.md', url: 'https://example.com/1', imageUrl: tooLong }]);
    const slack = mockSlack();

    await runWeeklyDigest(makeEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect((groupsOf(posted.blocks)['clip-0']?.[0] as { accessory?: unknown }).accessory).toBeUndefined();
    // 長すぎると分かっている時点で捨てるので、取得も試みない。
    expect(slack.imageRequests).toEqual([]);
  });

  it('posts without an idempotency key so a rerun is not swallowed', async () => {
    // 渡すとSlackは重複と見なして新しいメッセージを作らず、既存のtsを返す。
    // cronは再試行されないので排除する対象が無く、渡すと「投稿できていないのに成功」
    // が起きて、表示していないクリップにmarkDigestShownが印を打つ（ADR 0011）。
    await seed([{ path: 'clips/qiita.com/記事.md', url: 'https://example.com/1' }]);
    const slack = mockSlack();

    await runWeeklyDigest(makeEnv({ THREAD: threadStub().namespace }));

    expect(slack.bodies['chat.postMessage']).not.toHaveProperty('client_msg_id');
  });

  it('does not mark clips as shown when the post fails', async () => {
    await seed([{ path: 'clips/qiita.com/記事.md' }]);
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
    expect(posted.blocks).toHaveLength(2);
    expect(JSON.stringify(posted.blocks)).toContain('いまは残っていない');
    // 会話へ残す中身が無いので、スレッドは作らない。
    expect(thread.names).toEqual([]);
  });
});

describe('keepClipBlocks', () => {
  it('keeps only the rows that are still waiting and counts down the heading', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/example.com/a.md', url: 'https://example.com/a' }),
      digestClip({ path: 'clips/example.com/b.md', url: 'https://example.com/b' }),
    ]);

    const remaining = keepClipBlocks(blocks, new Set(['clips/example.com/b.md']));

    // 見出しと区切り、そのあと残った1件ぶんの3ブロック。
    expect(remaining).toHaveLength(5);
    expect(JSON.stringify(remaining[0])).toContain('1件');
    expect(JSON.stringify(remaining)).toContain('clips/example.com/b.md');
    expect(JSON.stringify(remaining)).not.toContain('clips/example.com/a.md');
  });

  it('keeps the whole group so the row does not lose its button or meta line', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/example.com/a.md', url: 'https://example.com/a' }),
      digestClip({
        path: 'clips/zenn.dev/b.md',
        url: 'https://example.com/b',
        excerpt: '残るほうの抜粋',
      }),
    ]);

    const remaining = keepClipBlocks(blocks, new Set(['clips/zenn.dev/b.md']));

    expect((remaining as Record<string, unknown>[]).map((block) => block.type)).toEqual([
      'header',
      'divider',
      'section',
      'actions',
      'context',
    ]);
    expect(JSON.stringify(remaining)).toContain('残るほうの抜粋');
    expect(JSON.stringify(remaining)).toContain('zenn.dev');
  });

  it('leaves only the heading when the last row goes', () => {
    const blocks = digestBlocks(makeEnv(), [digestClip({ path: 'clips/example.com/a.md' })]);

    const remaining = keepClipBlocks(blocks, new Set());

    expect(remaining).toHaveLength(2);
    expect(JSON.stringify(remaining)).toContain('いまは残っていない');
  });

  it('escapes a pipe in the article URL so the link does not break', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/example.com/記事.md', url: 'https://example.com/a?x=b|c' }),
    ]);

    expect(JSON.stringify(blocks)).toContain('https://example.com/a?x=b%7Cc|記事');
  });
});
