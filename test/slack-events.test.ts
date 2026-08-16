import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { addSlackReaction, verifySlackSignature } from '../src/slack';
import type { ChatJob } from '../src/types';
import { makeEnv, signedSlackRequest } from './helpers';

afterEach(() => vi.restoreAllMocks());

/** Slack APIをまとめてモックする。既定はすべて成功。 */
function mockSlackFetch(response: () => Response = () => slackResponse({ ok: true })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
}

function slackResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** モックしたfetchへ渡された、あるSlack APIメソッドのリクエストボディを取り出す。 */
function slackCallBodies(
  fetchMock: ReturnType<typeof mockSlackFetch>,
  method: string,
): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === `https://slack.com/api/${method}`)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe('Slack Events API', () => {
  it('answers a signed URL verification challenge', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      await signedSlackRequest({ type: 'url_verification', challenge: 'challenge-value' }),
      makeEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-value' });
  });

  it('rejects an invalid signature', async () => {
    const request = await signedSlackRequest({ type: 'event_callback' });
    request.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('rejects requests older than five minutes', async () => {
    expect(
      await verifySlackSignature('body', '100', `v0=${'0'.repeat(64)}`, 'secret', 401),
    ).toBe(false);
  });

  it('queues the message text as it arrived, without looking for URLs', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    const fetchMock = mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'Ev123',
      event_time: 1_700_000_000,
      team_id: 'T_ALLOWED',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_ALLOWED',
        channel: 'D123',
        ts: '1700000000.000100',
        text: '<https://example.com/one|one> これどう思う？',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      {
        version: 2,
        jobId: 'Ev123',
        text: '<https://example.com/one|one> これどう思う？',
        slackChannel: 'D123',
        slackThreadTs: '1700000000.000100',
        receivedAt: '2023-11-14T22:13:20.000Z',
      },
    ]);
    expect(slackCallBodies(fetchMock, 'reactions.add')).toEqual([
      { channel: 'D123', timestamp: '1700000000.000100', name: 'eyes' },
    ]);
    // 受付WorkerがSlackへ呼ぶのはreactions.addだけ。返信は後段のconsumerが送る。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queues a message without a URL as an ordinary conversation turn', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvNoUrl',
      team_id: 'T_ALLOWED',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_ALLOWED',
        channel: 'D123',
        ts: '1700000000.000200',
        text: 'あとで送る',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('あとで送る');
  });

  it('keys a threaded reply to the parent message, but reacts to the message itself', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    const fetchMock = mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvReply',
      team_id: 'T_ALLOWED',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_ALLOWED',
        channel: 'D123',
        ts: '1700000900.000500',
        thread_ts: '1700000000.000100',
        text: 'ここには何が書いてあるの？',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(sent[0]?.slackThreadTs).toBe('1700000000.000100');
    expect(slackCallBodies(fetchMock, 'reactions.add')).toEqual([
      { channel: 'D123', timestamp: '1700000900.000500', name: 'eyes' },
    ]);
  });

  it('ignores a direct message from a user outside the allowlist', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    const fetchMock = mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvDeniedUser',
      team_id: 'T_ALLOWED',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_DENIED',
        channel: 'D123',
        ts: '1700000000.000300',
        text: 'https://example.com/secret',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
    // 許可状態を外部へ明かさない（ADR 0002）。リアクションも見える出力なので付けない。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a direct message from another workspace', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    const fetchMock = mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvDeniedTeam',
      team_id: 'T_OTHER',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_ALLOWED',
        channel: 'D123',
        ts: '1700000000.000400',
        text: 'https://example.com/secret',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still queues the job when the reaction cannot be added', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
    mockSlackFetch(() => slackResponse({ ok: false, error: 'missing_scope' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvNoScope',
      team_id: 'T_ALLOWED',
      event: {
        type: 'message',
        channel_type: 'im',
        user: 'U_ALLOWED',
        channel: 'D123',
        ts: '1700000000.000600',
        text: 'リアクションは付かないけど処理は続く',
      },
    });
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing_scope');
  });
});

describe('addSlackReaction', () => {
  it('treats already_reacted as success, because Slack redelivers events', async () => {
    mockSlackFetch(() => slackResponse({ ok: false, error: 'already_reacted' }));
    await expect(
      addSlackReaction({
        token: 'xoxb-test',
        channel: 'D123',
        timestamp: '1700000000.000100',
        name: 'eyes',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws on any other Slack API error', async () => {
    mockSlackFetch(() => slackResponse({ ok: false, error: 'invalid_name' }));
    await expect(
      addSlackReaction({
        token: 'xoxb-test',
        channel: 'D123',
        timestamp: '1700000000.000100',
        name: 'eyes',
      }),
    ).rejects.toThrow('Slack reactions.add failed: invalid_name');
  });
});
