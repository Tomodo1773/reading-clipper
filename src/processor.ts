import type { ModelMessage } from 'ai';
import { SlackAPIClient } from 'slack-edge';
import { runChatTurn } from './chat';
import { asClipError, ClipError } from './errors';
import type { ChatJob, Env } from './types';

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
    let reply = stored.reply;
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
      );
      reply = turn.reply;
    }
    await slack.chat.postMessage({
      channel: job.slackChannel,
      thread_ts: job.slackThreadTs,
      text: reply,
      unfurl_links: false,
      unfurl_media: false,
    });
    message.ack();
  } catch (error) {
    const clipError = asClipError(error, 'validation');
    console.error(
      JSON.stringify({
        jobId: job?.jobId,
        stage: clipError.stage,
        status: clipError.status,
        // 同じstageでも原因が複数あるため、どれで落ちたかをログから判別できるようにする。
        message: clipError.message,
        retryable: clipError.retryable,
        attempts: message.attempts,
      }),
    );

    const giveUp = !clipError.retryable || message.attempts > MAX_QUEUE_RETRIES;
    // 返信先が読めない壊れたメッセージでは通知そのものが投げるため、送り先がある場合だけ通知する。
    if (giveUp && job?.slackChannel && job.slackThreadTs) {
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

    if (!clipError.retryable) {
      message.ack();
      return;
    }
    message.retry({
      delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900),
    });
  }
}
