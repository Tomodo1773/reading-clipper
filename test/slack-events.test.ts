import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { ChatJob, Env } from '../src/types';
import { jsonResponse, makeEnv, readSlackCall, signedSlackRequest, slackAuthTestResponse } from './helpers';

interface SlackCall {
  method: string;
  params: Record<string, unknown>;
}

let slackCalls: SlackCall[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  slackCalls = [];
});

/** Slack APIをまとめてモックする。`auth.test`以外の既定はすべて成功。 */
function mockSlackFetch(response: () => Response = () => jsonResponse({ ok: true })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const call = await readSlackCall(input);
    if (!call) throw new Error(`unexpected request: ${String(input)}`);
    slackCalls.push(call);
    return call.method === 'auth.test' ? slackAuthTestResponse() : response();
  });
}

/** あるSlack APIメソッドへ渡されたリクエストボディを取り出す。 */
function slackCallBodies(method: string): Record<string, unknown>[] {
  return slackCalls.filter((call) => call.method === method).map((call) => call.params);
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
    // slack-edgeはchallengeを素のテキストで返す。SlackはJSONとテキストのどちらも受ける。
    expect(await response.text()).toBe('challenge-value');
  });

  it('rejects an invalid signature', async () => {
    const request = await signedSlackRequest({ type: 'event_callback' });
    request.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it('queues the message text as it arrived, without looking for URLs', async () => {
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
    expect(slackCallBodies('reactions.add')).toEqual([
      { channel: 'D123', timestamp: '1700000000.000100', name: 'eyes' },
    ]);
    // 受付WorkerがSlackへ呼ぶのは、slack-edgeのauth.testとreactions.addだけ。
    // 返信は後段のconsumerが送る。
    expect(slackCalls.map((call) => call.method)).toEqual(['auth.test', 'reactions.add']);
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
    mockSlackFetch();
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
    expect(slackCallBodies('reactions.add')).toEqual([
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

  /**
   * secretが未登録だと `env` の値は型に反して `undefined` になる。突き合わせる相手が
   * payload側にも無いと `undefined === undefined` が成立し、allowlistを素通りする。
   * READMEの「設定値が空欄の場合も全拒否する」はこの経路を指す。
   *
   * 各ケースは「未設定の側だけがpayloadからも欠けている」形にする。そこを揃えないと
   * もう一方の突き合わせが先に落ちてしまい、テストが穴を通り越して緑になる。
   */
  it.each([
    {
      name: 'team unset, and the payload carries no team_id',
      unset: { SLACK_ALLOWED_TEAM_ID: undefined },
      teamId: undefined,
      user: 'U_ALLOWED',
    },
    {
      name: 'user unset, and the payload carries no event.user',
      unset: { SLACK_ALLOWED_USER_ID: undefined },
      teamId: 'T_ALLOWED',
      user: undefined,
    },
    {
      name: 'both unset, and the payload carries neither',
      unset: { SLACK_ALLOWED_TEAM_ID: undefined, SLACK_ALLOWED_USER_ID: undefined },
      teamId: undefined,
      user: undefined,
    },
  ])('rejects everything when the allowlist is unconfigured ($name)', async (testCase) => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
      ...(testCase.unset as Partial<Env>),
    });
    const fetchMock = mockSlackFetch();
    const ctx = createExecutionContext();
    const request = await signedSlackRequest({
      type: 'event_callback',
      event_id: 'EvUnconfigured',
      ...(testCase.teamId ? { team_id: testCase.teamId } : {}),
      event: {
        type: 'message',
        channel_type: 'im',
        ...(testCase.user ? { user: testCase.user } : {}),
        channel: 'D123',
        ts: '1700000000.000700',
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
    mockSlackFetch(() => jsonResponse({ ok: false, error: 'missing_scope' }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain('missing_scope');
  });
});
