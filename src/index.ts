import { Hono } from 'hono';
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<ChatJob>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => handleQueueMessage(message, env)));
  },
} satisfies ExportedHandler<Env, ChatJob>;
