import { asClipError, ClipError } from './errors';
import { fetchContent } from './fetchers';
import { getGitHubFile, putGitHubFile, type GitHubFile } from './github';
import { renderClipMarkdown } from './markdown';
import { postSlackMessage } from './slack';
import {
  formatPartialReply,
  formatSuccessReply,
  summarizeContent,
  type SummaryResult,
} from './summarizer';
import type { ClipJob, Env } from './types';
import { buildClipPath, canonicalizeUrl } from './url';

export const MAX_QUEUE_RETRIES = 3;

async function replyToJob(
  job: ClipJob,
  env: Env,
  text: string,
  kind: 'result' | 'failure',
): Promise<void> {
  await postSlackMessage({
    token: env.SLACK_BOT_TOKEN,
    channel: job.slackChannel,
    threadTs: job.slackThreadTs,
    text,
    idempotencyKey: `${job.jobId}:${kind}`,
  });
}

function validateJob(job: ClipJob): void {
  if (
    job.version !== 1 ||
    !job.jobId ||
    !job.url ||
    !job.slackChannel ||
    !job.slackThreadTs ||
    !job.receivedAt ||
    !Number.isInteger(job.ignoredUrlCount) ||
    job.ignoredUrlCount < 0
  ) {
    throw new ClipError('Queue message was invalid', 'validation', false);
  }
}

export async function processClipJob(job: ClipJob, env: Env, attempts: number): Promise<void> {
  validateJob(job);
  const canonicalUrl = canonicalizeUrl(job.url).toString();
  // 保存先は記事タイトルから決めるため、取得を先に行う。
  const content = await fetchContent(canonicalUrl, env);
  const path = buildClipPath(canonicalUrl, content.title);
  // 既存ファイルの更新にはshaが要る。同じタイトルの記事は上書きする。
  const existing = await getGitHubFile(env, path);

  let summary: SummaryResult | undefined;
  try {
    summary = await summarizeContent(content, env);
  } catch (error) {
    const summaryError = asClipError(error, 'summary');
    if (summaryError.retryable && attempts <= MAX_QUEUE_RETRIES) throw summaryError;
    console.warn(
      JSON.stringify({ jobId: job.jobId, stage: 'summary', status: summaryError.status, partial: true }),
    );
  }

  const markdown = renderClipMarkdown({ job, content });
  let saved: GitHubFile;
  try {
    saved = await putGitHubFile(env, path, markdown, existing?.sha);
  } catch (error) {
    const saveError = asClipError(error, 'github');
    if (saveError.status !== 409) throw saveError;
    // 同じパスを別の処理が先に更新した。内容はそちらのものになるが、返信はできる。
    const concurrent = await getGitHubFile(env, path);
    if (!concurrent) throw saveError;
    saved = concurrent;
  }

  await replyToJob(
    job,
    env,
    summary
      ? formatSuccessReply(summary, content.complete, saved.htmlUrl, job.ignoredUrlCount)
      : formatPartialReply(saved.htmlUrl, job.ignoredUrlCount),
    'result',
  );
}

export function failureReply(error: ClipError): string {
  switch (error.stage) {
    case 'validation':
      return 'そのURL、私には扱えないわ。HTTP(S)のURLを送り直してちょうだい。';
    case 'fetch':
      return '中身が取れなかったわ。取れていないものを保存も要約もするわけにはいかないから、今回は何も残していないわよ。';
    case 'summary':
      return '要約を作れなかったわ。本文もまだ保存していないから、少し時間を置いて送り直してちょうだい。';
    case 'github':
      return 'GitHubへの保存に失敗したわ。成功したことにはしないから、設定を確認して送り直してね。';
    case 'slack':
      return 'Slackへの返信に失敗したわ。処理自体は終わっているかもしれないから、GitHubの方も見ておいてちょうだい。';
  }
}

export async function handleQueueMessage(
  message: Message<ClipJob>,
  env: Env,
): Promise<void> {
  try {
    await processClipJob(message.body, env, message.attempts);
    message.ack();
  } catch (error) {
    const clipError = asClipError(error, 'validation');
    console.error(
      JSON.stringify({
        jobId: message.body?.jobId,
        stage: clipError.stage,
        status: clipError.status,
        retryable: clipError.retryable,
        attempts: message.attempts,
      }),
    );

    if (!clipError.retryable || message.attempts > MAX_QUEUE_RETRIES) {
      try {
        await replyToJob(message.body, env, failureReply(clipError), 'failure');
      } catch (replyError) {
        const slackError = asClipError(replyError, 'slack');
        console.error(
          JSON.stringify({
            jobId: message.body?.jobId,
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
