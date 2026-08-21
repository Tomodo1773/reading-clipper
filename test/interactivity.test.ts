import { createExecutionContext, env as testEnv, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBlocks } from '../src/digest';
import { clipReplyBlocks } from '../src/dismiss';
import worker from '../src/index';
import {
  jsonResponse,
  makeEnv,
  readSlackCall,
  resetClips,
  signedInteractivityRequest,
  slackAuthTestResponse,
} from './helpers';

const CLIP_PATH = 'clips/記事.md';
const OTHER_PATH = 'clips/別の記事.md';

describe('エージェント返信のblocks', () => {
  it('keeps a reply at the Markdown block limit unchanged', () => {
    const reply = 'あ'.repeat(12_000);

    expect(clipReplyBlocks(reply, [])[0]).toEqual({ type: 'markdown', text: reply });
  });

  it('truncates an over-limit reply without splitting a surrogate pair', () => {
    const reply = `${'あ'.repeat(11_998)}😀末尾`;
    const block = clipReplyBlocks(reply, [])[0];

    expect(block).toEqual({ type: 'markdown', text: `${'あ'.repeat(11_998)}😀…` });
    expect([...(block?.type === 'markdown' ? block.text : '')]).toHaveLength(12_000);
  });
});

/** 投稿されたダイジェストのblocks。押した時点のSlackのpayloadに丸ごと入ってくる。 */
const POSTED_BLOCKS = digestBlocks(makeEnv(), [
  {
    path: CLIP_PATH,
    url: 'https://qiita.com/a/items/1',
    title: '記事',
    excerpt: '抜粋',
    imageUrl: 'https://img.example.com/1.png',
    clippedAt: '2026-02-03T00:00:00.000Z',
  },
  {
    path: OTHER_PATH,
    url: 'https://zenn.dev/a/articles/b',
    title: '別の記事',
    excerpt: '別の抜粋',
    imageUrl: null,
    clippedAt: '2026-02-03T00:00:00.000Z',
  },
]);

function buttonPress(path = CLIP_PATH, overrides: Record<string, unknown> = {}) {
  return {
    type: 'block_actions',
    team: { id: 'T_ALLOWED' },
    user: { id: 'U_ALLOWED' },
    channel: { id: 'D123' },
    message: { ts: '1700000000.000100', blocks: POSTED_BLOCKS },
    actions: [{ type: 'button', action_id: 'dismiss_clip', value: path }],
    ...overrides,
  };
}

interface PostedUpdate {
  channel: string;
  ts: string;
  blocks: unknown[];
}

function mockSlack(): PostedUpdate[] {
  const updates: PostedUpdate[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const call = await readSlackCall(input);
    if (call?.method === 'auth.test') return slackAuthTestResponse();
    if (call?.method !== 'chat.update') throw new Error(`unexpected request: ${String(input)}`);
    updates.push({
      channel: String(call.params.channel),
      ts: String(call.params.ts),
      blocks: call.params.blocks as unknown[],
    });
    return jsonResponse({ ok: true });
  });
  return updates;
}

function dismissedAt(path: string): Promise<{ dismissed_at: string | null } | null> {
  return testEnv.CLIPS.prepare('SELECT dismissed_at FROM clips WHERE path = ?')
    .bind(path)
    .first<{ dismissed_at: string | null }>();
}

async function seed(): Promise<void> {
  for (const path of [CLIP_PATH, OTHER_PATH]) {
    await testEnv.CLIPS.prepare('INSERT INTO clips (path, url, clipped_at) VALUES (?, ?, ?)')
      .bind(path, `https://example.com/${path}`, '2026-08-01T00:00:00.000Z')
      .run();
  }
}

/** 署名付きの押下を1回、waitUntilの完了まで含めて処理する。 */
async function press(path = CLIP_PATH, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    await signedInteractivityRequest(buttonPress(path, overrides)),
    makeEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(resetClips);
afterEach(() => vi.restoreAllMocks());

describe('ダイジェストのボタン押下', () => {
  it('rejects an invalid signature', async () => {
    const request = await signedInteractivityRequest(buttonPress());
    request.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('dismisses the clip and drops its row from the posted message', async () => {
    await seed();
    const updates = mockSlack();

    // 3秒ACKを守るため、D1の更新もchat.updateも応答を返してから走る。
    expect((await press()).status).toBe(200);

    expect((await dismissedAt(CLIP_PATH))?.dismissed_at).not.toBeNull();
    expect(updates).toHaveLength(1);
    const update = updates[0]!;
    expect(update.channel).toBe('D123');
    expect(update.ts).toBe('1700000000.000100');
    // 見出しと区切り、残った1件ぶんの3ブロック。
    expect(update.blocks).toHaveLength(5);
    expect(JSON.stringify(update.blocks)).not.toContain(CLIP_PATH);
    expect(JSON.stringify(update.blocks)).toContain(OTHER_PATH);
    // 差し替えでもサムネイルを取り直さない。payloadのblocksをそのまま使う。
    expect(JSON.stringify(update.blocks)).toContain('別の抜粋');
  });

  it('does not bring back a row that an earlier press already dismissed', async () => {
    // 続けて押すと、2回目のpayloadは1回目のchat.updateが届く前のblocksを含む。
    // 差分で組み立てると、片付けたばかりの行がボタンごと書き戻る。
    await seed();
    const updates = mockSlack();

    await press(CLIP_PATH);
    await press(OTHER_PATH);

    const last = updates.at(-1)!;
    expect(last.blocks).toHaveLength(2);
    expect(JSON.stringify(last.blocks)).not.toContain(CLIP_PATH);
    expect(JSON.stringify(last.blocks)).not.toContain(OTHER_PATH);
  });

  it('ignores a press from outside the allowlist without touching anything', async () => {
    await seed();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Slack must not be called');
    });

    expect((await press(CLIP_PATH, { user: { id: 'U_DENIED' } })).status).toBe(200);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await dismissedAt(CLIP_PATH))?.dismissed_at).toBeNull();
  });

  it('ignores a press from another workspace', async () => {
    await seed();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Slack must not be called');
    });

    expect((await press(CLIP_PATH, { team: { id: 'T_OTHER' } })).status).toBe(200);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await dismissedAt(CLIP_PATH))?.dismissed_at).toBeNull();
  });

  it('leaves the state alone when the same button is pressed twice', async () => {
    await seed();
    mockSlack();

    await press();
    await press();

    expect((await dismissedAt(CLIP_PATH))?.dismissed_at).not.toBeNull();
  });
});

/**
 * クリップ直後の返信に付くボタン（ADR 0015）。
 * ダイジェストと同じ`action_id`・同じ組み直しで、押された組がメッセージから消える。
 */
describe('返信のボタン押下', () => {
  const REPLY =
    '要するにQueueで分けろという話よ。[GitHub](https://github.com/example/clips/blob/main/a.md)に置いたわ。';

  function replyPress(path: string, clips: { path: string; title: string }[]) {
    return {
      type: 'block_actions',
      team: { id: 'T_ALLOWED' },
      user: { id: 'U_ALLOWED' },
      channel: { id: 'D123' },
      message: {
        ts: '1700000000.000300',
        text: REPLY,
        blocks: clipReplyBlocks(REPLY, clips),
      },
      actions: [{ type: 'button', action_id: 'dismiss_clip', value: path }],
    };
  }

  async function pressReply(
    path: string,
    clips: { path: string; title: string }[],
  ): Promise<void> {
    const ctx = createExecutionContext();
    await worker.fetch(await signedInteractivityRequest(replyPress(path, clips)), makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
  }

  it('dismisses the clip and leaves the reply text in place', async () => {
    await seed();
    const updates = mockSlack();

    await pressReply(CLIP_PATH, [{ path: CLIP_PATH, title: '記事' }]);

    expect((await dismissedAt(CLIP_PATH))?.dismissed_at).not.toBeNull();
    // 本文はクリップの組に属さないので残り、ボタンだけが消える。
    expect(updates[0]?.blocks).toEqual([
      { type: 'markdown', text: REPLY },
    ]);
  });

  it('keeps the buttons of the clips that are still waiting', async () => {
    await seed();
    const updates = mockSlack();

    await pressReply(CLIP_PATH, [
      { path: CLIP_PATH, title: '記事' },
      { path: OTHER_PATH, title: '別の記事' },
    ]);

    expect((await dismissedAt(OTHER_PATH))?.dismissed_at).toBeNull();
    expect(JSON.stringify(updates[0]?.blocks)).toContain(OTHER_PATH);
    expect(JSON.stringify(updates[0]?.blocks)).not.toContain(CLIP_PATH);
  });

  /**
   * GitHubへは保存できたがD1の記録に失敗すると、ボタンはあるのに台帳に行が無い。
   * D1が返さない以上、片付いたものと区別せずに消す。ダイジェストの孤児行と同じ扱いである。
   */
  it('drops the button of a clip that is not in the ledger', async () => {
    const updates = mockSlack();

    await pressReply(CLIP_PATH, [{ path: CLIP_PATH, title: '記事' }]);

    expect(JSON.stringify(updates[0]?.blocks)).not.toContain(CLIP_PATH);
  });
});
