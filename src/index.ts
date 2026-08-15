import { Hono } from 'hono';
import { handleQueueMessage } from './processor';
import { postSlackMessage, verifySlackSignature } from './slack';
import type { ClipJob, Env } from './types';
import { extractUrls } from './url';

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

  const urls = extractUrls(event.text!);
  if (urls.length === 0) {
    c.executionCtx.waitUntil(
      postSlackMessage({
        token: c.env.SLACK_BOT_TOKEN,
        channel: event.channel!,
        threadTs: event.ts!,
        text: 'URLが見つからなかったよ。HTTP(S)のURLを1件送ってね。',
        idempotencyKey: `${payload.event_id}:no-url`,
      }).catch((error: unknown) => {
        console.error(
          JSON.stringify({ jobId: payload.event_id, stage: 'slack', noUrlReplyFailed: true }),
        );
      }),
    );
    return c.json({ ok: true });
  }

  const job: ClipJob = {
    version: 1,
    jobId: payload.event_id!,
    url: urls[0]!,
    slackChannel: event.channel!,
    slackThreadTs: event.ts!,
    receivedAt: new Date((payload.event_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    ignoredUrlCount: Math.max(0, urls.length - 1),
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
  async queue(batch: MessageBatch<ClipJob>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => handleQueueMessage(message, env)));
  },
} satisfies ExportedHandler<Env, ClipJob>;
