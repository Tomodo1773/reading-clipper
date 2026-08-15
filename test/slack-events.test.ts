import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { verifySlackSignature } from '../src/slack';
import type { ClipJob } from '../src/types';
import { makeEnv, signedSlackRequest } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('Slack Events API', () => {
  it('answers a signed URL verification challenge', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      await signedSlackRequest({ type: 'url_verification', challenge: 'challenge-value' }),
      makeEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'challenge-value' });
  });

  it('rejects an invalid signature', async () => {
    const request = await signedSlackRequest({ type: 'event_callback' });
    request.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
    const response = await worker.fetch(request, makeEnv(), createExecutionContext());
    expect(response.status).toBe(401);
  });

  it('rejects requests older than five minutes', async () => {
    expect(
      await verifySlackSignature('body', '100', `v0=${'0'.repeat(64)}`, 'secret', 401),
    ).toBe(false);
  });

  it('queues only the first URL from a direct user message', async () => {
    const sent: ClipJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ClipJob) => void sent.push(job),
      } as unknown as Queue<ClipJob>,
    });
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
        text: '<https://example.com/one|one> https://example.com/two',
      },
    });
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(sent).toEqual([
      expect.objectContaining({
        version: 1,
        jobId: 'Ev123',
        url: 'https://example.com/one',
        slackChannel: 'D123',
        slackThreadTs: '1700000000.000100',
        ignoredUrlCount: 1,
      }),
    ]);
  });

  it('replies asynchronously when no URL is present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
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
    const response = await worker.fetch(request, makeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.thread_ts).toBe('1700000000.000200');
    expect(body.text).toContain('URLが見つからなかった');
  });

  it('ignores a direct message from a user outside the allowlist', async () => {
    const sent: ClipJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ClipJob) => void sent.push(job),
      } as unknown as Queue<ClipJob>,
    });
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
    const response = await worker.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('ignores a direct message from another workspace', async () => {
    const sent: ClipJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ClipJob) => void sent.push(job),
      } as unknown as Queue<ClipJob>,
    });
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
    const response = await worker.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
