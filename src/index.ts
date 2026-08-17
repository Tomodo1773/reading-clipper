import { Hono } from 'hono';
import { dismissDigestClip, DISMISS_ACTION_ID, runWeeklyDigest } from './digest';
import { asClipError } from './errors';
import { handleQueueMessage } from './processor';
import { addSlackReaction, verifySlackSignature } from './slack';
import type { ChatJob, Env } from './types';

export { ThreadAgent } from './thread';

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event_time?: number;
  team_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

/** ダイジェストのボタン押下。Events APIとは別のRequest URLへ届く（ADR 0010）。 */
interface SlackInteractivityPayload {
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; blocks?: unknown[] };
  actions?: Array<{ action_id?: string; value?: string }>;
}

/** 受け取った印としてメッセージへ付ける絵文字。完了時に外さない。 */
const RECEIVED_REACTION = 'eyes';

const app = new Hono<{ Bindings: Env }>();

function isAllowedSlackUser(userId: string, allowedUserId: string | undefined): boolean {
  return Boolean(allowedUserId) && userId === allowedUserId;
}

app.get('/health', (c) => c.text('ok'));

app.post('/slack/events', async (c) => {
  const body = await c.req.text();
  const valid = await verifySlackSignature(
    body,
    c.req.header('x-slack-request-timestamp') ?? null,
    c.req.header('x-slack-signature') ?? null,
    c.env.SLACK_SIGNING_SECRET,
  );
  if (!valid) return c.json({ error: 'invalid_signature' }, 401);

  let payload: SlackEventEnvelope;
  try {
    payload = JSON.parse(body) as SlackEventEnvelope;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (payload.type === 'url_verification' && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const event = payload.event;
  const isDirectUserMessage =
    payload.type === 'event_callback' &&
    payload.event_id &&
    event?.type === 'message' &&
    event.channel_type === 'im' &&
    !event.subtype &&
    !event.bot_id &&
    typeof event.user === 'string' &&
    event.channel &&
    event.ts &&
    typeof event.text === 'string';
  if (!isDirectUserMessage) return c.json({ ok: true });

  // Slack署名だけでは送信者を認証できない。未許可なら情報を返さずACKだけする。
  if (
    payload.team_id !== c.env.SLACK_ALLOWED_TEAM_ID ||
    !isAllowedSlackUser(event.user!, c.env.SLACK_ALLOWED_USER_ID)
  ) {
    return c.json({ ok: true });
  }

  // 受け取った印をすぐ返す。consumerは max_concurrency:1 で前のジョブを待つため、
  // ここで付けないと「即座」にならない。3秒ACKを守るためawaitしない。
  c.executionCtx.waitUntil(
    addSlackReaction({
      token: c.env.SLACK_BOT_TOKEN,
      channel: event.channel!,
      // 会話状態のキー（thread_ts）ではなく、届いたメッセージ自身のtsに付ける。
      timestamp: event.ts!,
      name: RECEIVED_REACTION,
    }).catch((error: unknown) => {
      const clipError = asClipError(error, 'slack');
      console.warn(
        JSON.stringify({
          jobId: payload.event_id,
          stage: clipError.stage,
          status: clipError.status,
          message: clipError.message,
          reactionFailed: true,
        }),
      );
    }),
  );

  // URLの有無で分岐せず、届いた本文をそのままエージェントへ渡す（ADR 0006）。
  const job: ChatJob = {
    version: 2,
    jobId: payload.event_id!,
    text: event.text!,
    slackChannel: event.channel!,
    // スレッド内の返信は親のtsに寄せる。会話状態のキーがぶれないようにするため。
    slackThreadTs: event.thread_ts ?? event.ts!,
    receivedAt: new Date((payload.event_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
  try {
    await c.env.CLIP_QUEUE.send(job);
  } catch {
    return c.json({ error: 'queue_unavailable' }, 503);
  }
  return c.json({ ok: true });
});

app.post('/slack/interactivity', async (c) => {
  // Slackはインタラクティブpayloadも`v0:{timestamp}:{rawBody}`で署名する。
  // bodyは`payload=`のform urlencodedなので、検証にはパース前の生の文字列を使う。
  // workerdは`.text()`をform urlencodedに対して警告するため、バイト列から自分で起こす。
  const body = new TextDecoder().decode(await c.req.arrayBuffer());
  const valid = await verifySlackSignature(
    body,
    c.req.header('x-slack-request-timestamp') ?? null,
    c.req.header('x-slack-signature') ?? null,
    c.env.SLACK_SIGNING_SECRET,
  );
  if (!valid) return c.json({ error: 'invalid_signature' }, 401);

  let payload: SlackInteractivityPayload;
  try {
    const encoded = new URLSearchParams(body).get('payload') ?? '';
    payload = JSON.parse(encoded) as SlackInteractivityPayload;
  } catch {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  if (
    payload.team?.id !== c.env.SLACK_ALLOWED_TEAM_ID ||
    !isAllowedSlackUser(payload.user?.id ?? '', c.env.SLACK_ALLOWED_USER_ID)
  ) {
    return c.json({ ok: true });
  }

  const action = payload.actions?.[0];
  const path = action?.action_id === DISMISS_ACTION_ID ? action.value : undefined;
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  if (!path || !channel || !messageTs) return c.json({ ok: true });

  // Slackは3秒で切る。D1の更新とメッセージの差し替えは応答を返してから行う。
  c.executionCtx.waitUntil(
    dismissDigestClip(c.env, {
      path,
      channel,
      messageTs,
      blocks: payload.message?.blocks ?? [],
    }).catch((error: unknown) => {
      const clipError = asClipError(error, 'clips');
      console.error(
        JSON.stringify({
          stage: clipError.stage,
          status: clipError.status,
          message: clipError.message,
          dismissFailed: path,
        }),
      );
    }),
  );
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ChatJob>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => handleQueueMessage(message, env)));
  },
  /** 週次ダイジェスト（ADR 0010）。失敗は再試行されないので、事実だけログへ残す。 */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runWeeklyDigest(env);
    } catch (error) {
      const clipError = asClipError(error, 'slack');
      console.error(
        JSON.stringify({
          digest: true,
          stage: clipError.stage,
          status: clipError.status,
          message: clipError.message,
        }),
      );
      throw error;
    }
  },
} satisfies ExportedHandler<Env, ChatJob>;
