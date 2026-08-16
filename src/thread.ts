import { DurableObject } from 'cloudflare:workers';
import { type ChatMessage, runChatTurn } from './chat';
import { asClipError, type ProcessingStage } from './errors';
import { postSlackMessage } from './slack';
import type { ChatJob, Env } from './types';

/**
 * ターンの結果。例外ではなく値で返す。
 * RPC境界を越えると`ClipError`のクラス情報が落ち、stage/retryable/statusが失われるため。
 */
export type TurnOutcome =
  | { ok: true }
  | { ok: false; stage: ProcessingStage; retryable: boolean; status?: number; message: string };

/**
 * Slackのスレッド1本ぶんの会話。`{channel}:{thread_ts}` で引く（ADR 0007）。
 *
 * 会話はモデルへ渡す形のまま、tool_call と tool 結果を含めて追記だけしていく。
 * 記事本文はツール結果の中に残るため、2ターン目以降に取得も読み直しも行わない。
 */
export class ThreadAgent extends DurableObject<Env> {
  /**
   * ターンの実行を直列化する。DOのJSは単一スレッドだが、awaitをまたぐと処理が交錯するため、
   * 同じスレッドへ立て続けに届いた2通でエージェントループが並走しないようにする。
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS turns (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           message TEXT NOT NULL,
           at TEXT NOT NULL
         )`,
      );
      // 返信本文まで持つのは、Slackへの投稿だけが失敗した再試行で会話をやり直さないため。
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS handled (
           event_id TEXT PRIMARY KEY,
           reply TEXT NOT NULL,
           at TEXT NOT NULL
         )`,
      );
    });
  }

  async handle(job: ChatJob): Promise<TurnOutcome> {
    const run = this.chain.then(
      () => this.runTurn(job),
      () => this.runTurn(job),
    );
    this.chain = run.catch(() => undefined);
    try {
      await run;
      return { ok: true };
    } catch (error) {
      const clipError = asClipError(error, 'chat');
      return {
        ok: false,
        stage: clipError.stage,
        retryable: clipError.retryable,
        status: clipError.status,
        message: clipError.message,
      };
    }
  }

  private history(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<{ message: string }>('SELECT message FROM turns ORDER BY seq')
      .toArray()
      .map((row) => JSON.parse(row.message) as ChatMessage);
  }

  private storedReply(eventId: string): string | undefined {
    return this.ctx.storage.sql
      .exec<{ reply: string }>('SELECT reply FROM handled WHERE event_id = ?', eventId)
      .toArray()[0]?.reply;
  }

  private async runTurn(job: ChatJob): Promise<void> {
    let reply = this.storedReply(job.jobId);
    if (reply === undefined) {
      const turn = await runChatTurn({
        env: this.env,
        history: this.history(),
        userText: job.text,
        receivedAt: job.receivedAt,
      });
      // ターンの途中で落ちた場合は何も書かない。再試行はモデルの呼び出しからやり直す。
      const at = new Date().toISOString();
      for (const message of turn.appended) {
        this.ctx.storage.sql.exec(
          'INSERT INTO turns (message, at) VALUES (?, ?)',
          JSON.stringify(message),
          at,
        );
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO handled (event_id, reply, at) VALUES (?, ?, ?)',
        job.jobId,
        turn.reply,
        at,
      );
      reply = turn.reply;
    }

    await postSlackMessage({
      token: this.env.SLACK_BOT_TOKEN,
      channel: job.slackChannel,
      threadTs: job.slackThreadTs,
      text: reply,
      idempotencyKey: `${job.jobId}:reply`,
    });
  }
}
