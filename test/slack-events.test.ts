import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { verifySlackSignature } from '../src/slack';
import type { ChatJob } from '../src/types';
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

  it('queues the message text as it arrived, without looking for URLs', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
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
        text: '<https://example.com/one|one> これどう思う？',
      },
    });
    const response = await worker.fetch(request, env, createExecutionContext());
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
  });

  it('queues a message without a URL as an ordinary conversation turn', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
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
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('あとで送る');
  });

  it('keys a threaded reply to the parent message, not to its own ts', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
    });
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
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(sent[0]?.slackThreadTs).toBe('1700000000.000100');
  });

  it('ignores a direct message from a user outside the allowlist', async () => {
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
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
    const sent: ChatJob[] = [];
    const env = makeEnv({
      CLIP_QUEUE: {
        send: async (job: ChatJob) => void sent.push(job),
      } as unknown as Queue<ChatJob>,
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
