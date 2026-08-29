import { type ButtonAction, type MessageBlockAction, SlackApp } from 'slack-edge';
import { runWeeklyDigest } from './digest';
import { DISMISS_ACTION_ID, dismissClip } from './dismiss';
import { handleQueueMessage } from './processor';
import { handleTranslateMessage, TRANSLATION_QUEUE } from './translate';
import type { ChatJob, Env, TranslateJob } from './types';

export { CoreMcpEntrypoint } from './core-rpc';
export { ToolState } from './tool-state';
export { ThreadAgent } from './thread';

/** 受け取った印としてメッセージへ付ける絵文字。完了時に外さない。 */
const RECEIVED_REACTION = 'eyes';

/**
 * Event SubscriptionsとInteractivity & Shortcutsの両方を、この1本のRequest URLへ向ける
 * （ADR 0014）。`routes.events`を渡すと、slack-edgeがこれ以外のパスを404で弾く。
 * 渡さないと未登録の任意のパスへも応答してしまう。
 */
const EVENTS_PATH = '/slack/events';

/**
 * 署名検証、`url_verification`への応答、payloadのパース、自分の投稿の除外はslack-edgeが持つ。
 * lazyハンドラは`waitUntil`で走るため30秒しか使えない。ここではQueueへ積むまでだけを行い、
 * 本処理は15分使えるQueue consumerでやる（ADR 0014）。
 */
function slackApp(env: Env): SlackApp<Env> {
  return new SlackApp({ env, routes: { events: EVENTS_PATH } })
    // Slack署名だけでは送信者を認証できない。未許可なら情報を返さずACKだけする（ADR 0002）。
    //
    // 設定値が空欄なら全拒否する。設定も payload も欠けていると比較が
    // `undefined === undefined` で成立してしまうため、突き合わせる前に設定の有無を見る。
    .beforeAuthorize(async (request) => {
      const allowed =
        Boolean(env.SLACK_ALLOWED_TEAM_ID) &&
        Boolean(env.SLACK_ALLOWED_USER_ID) &&
        request.context.teamId === env.SLACK_ALLOWED_TEAM_ID &&
        request.context.userId === env.SLACK_ALLOWED_USER_ID;
      return allowed ? undefined : { status: 200, body: '' };
    })
    .anyMessage(async ({ payload, body, context }) => {
      if (payload.subtype !== undefined || payload.channel_type !== 'im') return;

      // URLの有無で分岐せず、届いた本文をそのままエージェントへ渡す（ADR 0006）。
      const job: ChatJob = {
        version: 2,
        jobId: body.event_id,
        text: payload.text,
        slackChannel: payload.channel,
        // スレッド内の返信は親のtsに寄せる。会話状態のキーがぶれないようにするため。
        slackThreadTs: payload.thread_ts ?? payload.ts,
        receivedAt: new Date((body.event_time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      };
      await Promise.all([
        context.client.reactions
          .add({
            channel: payload.channel,
            // 会話状態のキー（thread_ts）ではなく、届いたメッセージ自身のtsに付ける。
            timestamp: payload.ts,
            name: RECEIVED_REACTION,
          })
          // 印が付かなくても本処理は続ける。Promise.allを落とすとQueueへの登録ごと巻き込む。
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({ jobId: body.event_id, reactionFailed: true, message: String(error) }),
            );
          }),
        env.CLIP_QUEUE.send(job),
      ]);
    })
    // ボタン押下はAIを経由せず直接D1を更新する（ADR 0010）。
    // ダイジェストの行も、クリップ直後の返信も、同じボタンで同じように片付く（ADR 0015）。
    .action<'button', MessageBlockAction<ButtonAction>>(
      { type: 'button', action_id: DISMISS_ACTION_ID },
      async () => {},
      async ({ payload }) => {
        const path = payload.actions[0]?.value;
        if (!path) return;
        await dismissClip(env, {
          path,
          channel: payload.channel.id,
          messageTs: payload.message.ts,
          text: payload.message.text,
          blocks: payload.message.blocks ?? [],
        });
      },
    );
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => slackApp(env).run(request, ctx),
  /**
   * 会話と翻訳で待ち行列を分けているので、どちらから届いたかで振り分ける（ADR 0027）。
   * 会話側は履歴の交錯を避けるため1件ずつ直列に消費する設定のままにしてある（ADR 0008）。
   */
  async queue(batch: MessageBatch<ChatJob | TranslateJob>, env: Env): Promise<void> {
    // どちらのハンドラも、受け取った本体の形を自分で検証してから使う。
    if (batch.queue === TRANSLATION_QUEUE) {
      const messages = batch.messages as Message<TranslateJob>[];
      await Promise.all(messages.map((message) => handleTranslateMessage(message, env)));
      return;
    }
    const messages = batch.messages as Message<ChatJob>[];
    await Promise.all(messages.map((message) => handleQueueMessage(message, env)));
  },
  /** 週次ダイジェスト（ADR 0010）。 */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runWeeklyDigest(env);
  },
} satisfies ExportedHandler<Env, ChatJob | TranslateJob>;
