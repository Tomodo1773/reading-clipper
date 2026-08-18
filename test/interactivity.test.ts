import { createExecutionContext, env as testEnv, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBlocks } from '../src/digest';
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
