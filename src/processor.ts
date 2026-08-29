import type { ModelMessage } from 'ai';
import { SlackAPIClient } from 'slack-edge';
import { runChatTurn } from './chat';
import { clipReplyBlocks } from './dismiss';
import { asClipError, ClipError, settleQueueFailure } from './errors';
import type { ChatJob, Env } from './types';

/** 詫びを出す回。配達を諦める回数そのものはqueue側の`max_retries`が持つ。 */
const MAX_QUEUE_RETRIES = 3;

function validateJob(job: ChatJob): void {
  if (
    job?.version !== 2 ||
    !job.jobId ||
    typeof job.text !== 'string' ||
    !job.slackChannel ||
    !job.slackThreadTs ||
    !job.receivedAt
  ) {
    throw new ClipError('Queue message was invalid', 'validation', false);
  }
}

/**
 * 返事を書くモデルまで届かなかった場合だけ使う固定文。
 * 保存の成否や記事の中身に触れる文はモデルが書く（ADR 0006）。
 * 相手に取れる行動は「送り直す」しかないので、原因ごとに文を分けない。
 */
function failureReply(error: ClipError): string {
  return error.stage === 'validation'
    ? 'そのメッセージ、私の方で受け取り損ねたわ。もう一度送ってちょうだい。'
    : '調子が悪くて言葉が出てこないわ。少し時間を置いて送り直してちょうだい。';
}

export async function handleQueueMessage(message: Message<ChatJob>, env: Env): Promise<void> {
  const job = message.body;
  const slack = new SlackAPIClient(env.SLACK_BOT_TOKEN);
  try {
    validateJob(job);
    const thread = env.THREAD.get(
      env.THREAD.idFromName(`${job.slackChannel}:${job.slackThreadTs}`),
    );
    const stored = await thread.load(job.jobId);
    let { reply, saved } = stored;
    if (reply === undefined) {
      const turn = await runChatTurn({
        env,
        history: stored.history.map((message) => JSON.parse(message) as ModelMessage),
        userText: job.text,
        receivedAt: job.receivedAt,
      });
      await thread.save(
        job.jobId,
        turn.appended.map((message) => JSON.stringify(message)),
        turn.reply,
        turn.saved,
      );
      reply = turn.reply;
      saved = turn.saved;
    }
    await slack.chat.postMessage({
      channel: job.slackChannel,
      thread_ts: job.slackThreadTs,
      // blocksを付けると本文はそちらが持つ。textは通知とblocksを読めないクライアント用に残す。
      text: reply,
      // 標準MarkdownをSlackに変換させ、保存が起きたターンにだけボタンを添える（ADR 0015, 0019）。
      blocks: clipReplyBlocks(reply, saved),
      unfurl_links: false,
      unfurl_media: false,
    });
    message.ack();
  } catch (error) {
    const clipError = asClipError(error, 'validation');
    settleQueueFailure(message, clipError, { jobId: job?.jobId });

    // 詫びは諦めたときの1回だけ出す。再試行のたびに言わない。
    const giveUp = !clipError.retryable || message.attempts > MAX_QUEUE_RETRIES;
    // 返信先が読めない壊れたメッセージでは通知そのものが投げるため、送り先がある場合だけ通知する。
    if (!giveUp || !job?.slackChannel || !job.slackThreadTs) return;
    try {
      await slack.chat.postMessage({
        channel: job.slackChannel,
        thread_ts: job.slackThreadTs,
        text: failureReply(clipError),
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (replyError) {
      const slackError = asClipError(replyError, 'slack');
      console.error(
        JSON.stringify({
          jobId: job?.jobId,
          stage: slackError.stage,
          status: slackError.status,
          notificationFailed: true,
        }),
      );
    }
  }
}
