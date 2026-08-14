import { Hono } from 'hono';
import type { ClipJob, Env } from './types';

/**
 * 受付側。SlackのEvents APIは3秒以内の応答を要求するため、
 * ここでは署名検証とQueueへの登録までを行い、本文取得・要約・保存はqueueハンドラーに渡す。
 *
 * 骨組みのみ。ハンドラーの中身は未実装で、意図的に失敗を返す。
 */
const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.post('/slack/events', (c) =>
  // 署名検証を伴わない200応答はSlackに受理として扱われ、
  // 未処理のURLを取りこぼす。実装するまでは明示的に失敗させる。
  c.json({ error: 'not_implemented' }, 501),
);

export default {
  fetch: app.fetch,

  /**
   * 処理側。URL別の取得、Markdown化、GitHub保存、AI要約、Slack返信を行う。
   *
   * 骨組みのみ。ackすると取り込めなかったURLが黙って消えるため、
   * 実装するまでは例外を投げてretryさせ、最終的にDLQへ送る。
   */
  async queue(batch: MessageBatch<ClipJob>, _env: Env): Promise<void> {
    throw new Error(
      `clip processing is not implemented yet (${batch.messages.length} message(s) left unacked)`,
    );
  },
} satisfies ExportedHandler<Env, ClipJob>;
