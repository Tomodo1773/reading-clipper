import { env as testEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestClip } from '../src/clips';
import { digestBlocks, runWeeklyDigest } from '../src/digest';
import { keepAliveClips } from '../src/dismiss';
import { resetGitHubTokenCache } from '../src/github';
import type { ThreadAgent } from '../src/thread';
import type { Env } from '../src/types';
import { generatePrivateKeyPem, jsonResponse, makeEnv, readSlackCall, resetClips } from './helpers';

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
  /** 実在確認でGitHubへ引きにいったパス（ADR 0018）。 */
  contentRequests: string[];
}

/**
 * GitHub側の応答。`missing`のパスは404を返し、`status`を渡すと全件その状態で失敗させる。
 * 「消えた」と「確かめられなかった」を区別するテストのために分けている。
 */
interface GitHubState {
  missing?: string[];
  status?: number;
}

function imageResponse(contentType = 'image/png'): Response {
  return new Response('binary', { headers: { 'content-type': contentType } });
}

/**
 * `https://img.example.com/` は取得できる画像、`https://gone.example.com/` は404を返す。
 * サムネイルの検証がここを通るので、Slack以外のリクエストも受け付ける必要がある。
 */
function mockSlack(github: GitHubState = {}): SlackCalls {
  const calls: SlackCalls = { bodies: {}, imageRequests: [], contentRequests: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    // ダイジェストは投稿前に、出す候補がGitHubに残っているかを引く（ADR 0018）。
    if (url.includes('/app/installations/')) {
      return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
    }
    if (url.includes('/repos/example/clips/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1] ?? '');
      calls.contentRequests.push(path);
      if (github.status) return jsonResponse({ message: 'boom' }, github.status);
      if (github.missing?.includes(path)) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({
        sha: 'file-sha',
        html_url: `https://github.com/example/clips/blob/main/${path}`,
      });
    }
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
    const { method, params } = (await readSlackCall(input))!;
    calls.bodies[method] = params;
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

let privateKeyPem: string;

/** 実在確認がGitHub App JWTを署名するので、ダイジェストのテストには実鍵が要る。 */
function digestEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({ GITHUB_APP_PRIVATE_KEY: privateKeyPem, ...overrides });
}

beforeEach(async () => {
  resetGitHubTokenCache();
  await resetClips();
  privateKeyPem = await generatePrivateKeyPem();
});
afterEach(() => vi.restoreAllMocks());

describe('weekly digest', () => {
  it('posts one message to the DM and leaves the list in the thread', async () => {
    await seed([
      { path: 'clips/バックフィルの記事.md' },
      {
        path: 'clips/ファイル名.md',
        url: 'https://zenn.dev/alice/articles/1',
        title: '保存した記事',
        excerpt: '本文の書き出しがここに入る。',
        imageUrl: 'https://img.example.com/1.png',
      },
    ]);
    const slack = mockSlack();
    const thread = threadStub();

    await runWeeklyDigest(
      digestEnv({ THREAD: thread.namespace }),
      new Date('2026-08-16T00:00:00.000Z'),
    );

    // cronにはSlackのイベントが無いので、DMのチャンネルIDはconversations.openで引く。
    expect(slack.bodies['conversations.open']).toEqual({ users: 'U_ALLOWED' });

    const posted = slack.bodies['chat.postMessage'] as { channel: string; blocks: unknown[] };
    expect(posted.channel).toBe('D123');
    // 見出しと区切り、そのあとクリップごとに本文section + メタ情報sectionの2ブロック。
    expect(posted.blocks).toHaveLength(6);
    // 件数は見出しに持たない。押すたびに数え直すことになるため（ADR 0015）。
    expect(slack.bodies['chat.postMessage']).toMatchObject({ text: '片付いていないクリップが2件' });
    expect(JSON.stringify(posted.blocks[0])).not.toContain('2件');

    const groups = groupsOf(posted.blocks);
    expect(Object.keys(groups)).toEqual(['clip-0', 'clip-1']);
    // urlがNULLの行（バックフィル由来）はGitHubのファイルへリンクする。
    expect(JSON.stringify(groups['clip-0'])).toContain(
      'https://github.com/example/clips/blob/main/clips/',
    );
    // タイトルが列にあればそれを使う。パス末尾はファイル名として削られている。
    expect(JSON.stringify(groups['clip-1'])).toContain('保存した記事');
    expect(JSON.stringify(groups['clip-1'])).toContain('本文の書き出しがここに入る。');
    expect(JSON.stringify(groups['clip-1'])).toContain('https://zenn.dev/alice/articles/1');
    // メタ行にはホストと保存時期を出す。ホストは保存先パスではなく`url`から取る（ADR 0013）。
    // mrkdwnにするとSlackが`<http://zenn.dev|zenn.dev>`へ変えてしまうのでplain_textで出す。
    const meta = groups['clip-1']?.[1] as {
      type: string;
      text: { type: string; text: string };
      accessory: { type: string; action_id: string; value: string };
    };
    expect(meta.type).toBe('section');
    expect(meta.text).toEqual({ type: 'plain_text', text: 'zenn.dev ・ 2026年8月に保存' });
    expect(meta.accessory).toMatchObject({
      type: 'button',
      action_id: 'dismiss_clip',
      value: 'clips/ファイル名.md',
    });

    // スレッドの文脈に一覧が残るので、「2番目のやつ片付けて」をAIが解決できる。
    expect(thread.names).toEqual(['D123:1700000000.000100']);
    const turns = thread.appended.map(
      (message) => JSON.parse(message) as { role: string; content: string },
    );
    // 履歴は他のターンと同じく user から始める。
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.content).toContain('1. バックフィルの記事（clips/バックフィルの記事.md）');
    expect(turns[1]?.content).toContain('2. 保存した記事（clips/ファイル名.md）');

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
      { path: 'clips/記事.md', url: 'https://example.com/1', imageUrl: 'https://img.example.com/1.png' },
    ]);
    const slack = mockSlack();

    await runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    const section = groupsOf(posted.blocks)['clip-0']?.[0] as { accessory?: Record<string, unknown> };
    expect(section.accessory).toMatchObject({
      type: 'image',
      image_url: 'https://img.example.com/1.png',
    });
    // 本文sectionの画像は維持し、ボタンは次のメタ情報sectionのaccessoryへ置く（ADR 0028）。
    const meta = groupsOf(posted.blocks)['clip-0']?.[1] as {
      type: string;
      accessory?: Record<string, unknown>;
    };
    expect(meta.type).toBe('section');
    expect(meta.accessory).toMatchObject({ type: 'button', action_id: 'dismiss_clip' });
  });

  it('drops an unreachable thumbnail but still posts the digest', async () => {
    // Slackは取得できないimage_urlを渡すとメッセージ全体を拒否する。渡す前に落とす。
    await seed([
      { path: 'clips/生きている.md', url: 'https://example.com/1', imageUrl: 'https://img.example.com/1.png' },
      { path: 'clips/消えた.md', url: 'https://example.com/2', imageUrl: 'https://gone.example.com/2.png' },
      { path: 'clips/画像でない.md', url: 'https://example.com/3', imageUrl: 'https://html.example.com/3' },
    ]);
    const slack = mockSlack();

    await runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace }));

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
    await seed([{ path: 'clips/記事.md', url: 'https://example.com/1', imageUrl: tooLong }]);
    const slack = mockSlack();

    await runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect((groupsOf(posted.blocks)['clip-0']?.[0] as { accessory?: unknown }).accessory).toBeUndefined();
    // 長すぎると分かっている時点で捨てるので、取得も試みない。
    expect(slack.imageRequests).toEqual([]);
  });

  it('does not mark clips as shown when the post fails', async () => {
    await seed([{ path: 'clips/記事.md' }]);
    // cronは再試行されないので、先に印を打つと一度も出ないまま順番の後ろへ回る。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      // 実在確認はここでは主題ではないので、素直に「残っている」を返す。
      // 投げさせて`stillOnGitHub`に握り潰させると、このテストが通る理由が濁る。
      if (url.includes('/app/installations/')) {
        return jsonResponse({ token: 'installation-token', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.includes('/repos/example/clips/contents/')) {
        return jsonResponse({ sha: 'file-sha', html_url: 'https://github.com/example/clips' });
      }
      if ((await readSlackCall(input))?.method === 'conversations.open') {
        return jsonResponse({ ok: false, error: 'missing_scope' });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(
      runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace })),
    ).rejects.toThrow('missing_scope');

    const row = await testEnv.CLIPS.prepare('SELECT last_shown_at FROM clips')
      .first<{ last_shown_at: string | null }>();
    expect(row?.last_shown_at).toBeNull();
  });

  it('says so when nothing is waiting, instead of going silent', async () => {
    const slack = mockSlack();
    const thread = threadStub();

    await runWeeklyDigest(
      digestEnv({ THREAD: thread.namespace }),
      new Date('2026-08-16T00:00:00.000Z'),
    );

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect(posted.blocks).toHaveLength(2);
    expect(JSON.stringify(posted.blocks)).toContain('いまは残っていない');
    // 会話へ残す中身が無いので、スレッドは作らない。
    expect(thread.names).toEqual([]);
  });

  it('drops a clip whose file is gone from GitHub, and deletes the row', async () => {
    // GitHubから消す操作は「片付ける」より強い意思表示なので、出し直さない（ADR 0018）。
    await seed([{ path: 'clips/消した記事.md' }, { path: 'clips/残した記事.md' }]);
    const slack = mockSlack({ missing: ['clips/消した記事.md'] });

    await runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace }));

    // 候補は投稿前に1件ずつ引く。ディレクトリ一覧もTrees APIも使わない。
    expect(slack.contentRequests.sort()).toEqual(['clips/残した記事.md', 'clips/消した記事.md']);
    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect(Object.keys(groupsOf(posted.blocks))).toHaveLength(1);
    expect(JSON.stringify(posted.blocks)).toContain('残した記事');
    expect(JSON.stringify(posted.blocks)).not.toContain('消した記事');

    const rows = await testEnv.CLIPS.prepare('SELECT path FROM clips').all<{ path: string }>();
    expect(rows.results.map((row) => row.path)).toEqual(['clips/残した記事.md']);
  });

  it('keeps the clip when the check itself fails, instead of deleting the row', async () => {
    // 「確かめられなかった」は「無い」ではない。GitHubが不調な週に台帳を削らない。
    await seed([{ path: 'clips/記事.md' }]);
    const slack = mockSlack({ status: 500 });

    await runWeeklyDigest(digestEnv({ THREAD: threadStub().namespace }));

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect(Object.keys(groupsOf(posted.blocks))).toHaveLength(1);
    const rows = await testEnv.CLIPS.prepare('SELECT path FROM clips').all<{ path: string }>();
    expect(rows.results).toHaveLength(1);
  });

  it('fills the digest from the extra candidates when one is gone', async () => {
    // 候補を7件より多めに取るのは、消えたぶんを埋めるため（ADR 0018）。
    await seed(Array.from({ length: 9 }, (_, index) => ({ path: `clips/記事${index}.md` })));
    const slack = mockSlack({ missing: ['clips/記事0.md'] });

    await runWeeklyDigest(
      digestEnv({ THREAD: threadStub().namespace }),
      new Date('2026-08-16T00:00:00.000Z'),
    );

    const posted = slack.bodies['chat.postMessage'] as { blocks: unknown[] };
    expect(Object.keys(groupsOf(posted.blocks))).toHaveLength(7);
    // 印が付くのは出した7件だけ。候補として引いただけの行には付かない。
    const shown = await testEnv.CLIPS.prepare(
      'SELECT count(*) AS n FROM clips WHERE last_shown_at IS NOT NULL',
    ).first<{ n: number }>();
    expect(shown?.n).toBe(7);
    const rows = await testEnv.CLIPS.prepare('SELECT count(*) AS n FROM clips').first<{ n: number }>();
    expect(rows?.n).toBe(8);
  });
});

describe('keepAliveClips', () => {
  it('keeps only the rows that are still waiting', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/a.md', url: 'https://example.com/a' }),
      digestClip({ path: 'clips/b.md', url: 'https://example.com/b' }),
    ]);

    const remaining = keepAliveClips(blocks, new Set(['clips/b.md']));

    // 見出しと区切りはクリップの組に属さないので、そのまま残る。
    expect(remaining).toHaveLength(4);
    expect(JSON.stringify(remaining)).toContain('clips/b.md');
    expect(JSON.stringify(remaining)).not.toContain('clips/a.md');
  });

  it('keeps the whole group so the row does not lose its compact button or meta line', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/a.md', url: 'https://example.com/a' }),
      digestClip({
        path: 'clips/b.md',
        url: 'https://zenn.dev/articles/b',
        excerpt: '残るほうの抜粋',
      }),
    ]);

    const remaining = keepAliveClips(blocks, new Set(['clips/b.md']));

    expect(remaining.map((block) => block.type)).toEqual([
      'header',
      'divider',
      'section',
      'section',
    ]);
    expect(JSON.stringify(remaining)).toContain('残るほうの抜粋');
    expect(JSON.stringify(remaining)).toContain('zenn.dev');
  });

  it('leaves the heading when the last row goes', () => {
    const blocks = digestBlocks(makeEnv(), [digestClip({ path: 'clips/a.md' })]);

    const remaining = keepAliveClips(blocks, new Set());

    expect(remaining.map((block) => block.type)).toEqual(['header', 'divider']);
  });
});

describe('digestBlocks', () => {
  it('puts the dismiss button beside metadata without changing the content section', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({
        path: 'clips/記事.md',
        url: 'https://example.com/a',
        excerpt: '記事の抜粋',
        imageUrl: 'https://example.com/image.png',
      }),
    ]);

    expect(blocks.map((block) => block.type)).toEqual([
      'header',
      'divider',
      'section',
      'section',
    ]);
    expect(blocks[2]).toMatchObject({
      type: 'section',
      text: { text: expect.stringContaining('記事の抜粋') },
      accessory: { type: 'image', image_url: 'https://example.com/image.png' },
    });
    expect(blocks[3]).toMatchObject({
      type: 'section',
      text: { type: 'plain_text', text: expect.stringContaining('example.com') },
      accessory: {
        type: 'button',
        text: { text: '片付ける' },
        action_id: 'dismiss_clip',
        value: 'clips/記事.md',
      },
    });
  });

  it('escapes a pipe in the article URL so the link does not break', () => {
    const blocks = digestBlocks(makeEnv(), [
      digestClip({ path: 'clips/記事.md', url: 'https://example.com/a?x=b|c' }),
    ]);

    expect(JSON.stringify(blocks)).toContain('https://example.com/a?x=b%7Cc|記事');
  });
});
