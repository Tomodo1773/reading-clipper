export type ProcessingStage =
  | 'validation'
  | 'fetch'
  | 'chat'
  | 'github'
  | 'slack'
  | 'clips';

export class ClipError extends Error {
  constructor(
    message: string,
    readonly stage: ProcessingStage,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ClipError';
  }
}

export function isRetryableStatus(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

/**
 * 本筋を止めない失敗を書き残す。落ちた段階を返すので、ツールの結果へそのまま載せられる。
 *
 * ツールの実処理、新着一覧の作り直し、翻訳の後始末が同じ形で出す。読む側が場所ごとに
 * 違う形を覚えなくて済むよう、組み立てはここだけに置く。
 */
export function logFailure(
  error: unknown,
  stage: ProcessingStage,
  tool: string,
  context: Record<string, unknown> = {},
): ProcessingStage {
  const clipError = asClipError(error, stage);
  console.warn(
    JSON.stringify({
      stage: clipError.stage,
      status: clipError.status,
      message: clipError.message,
      tool,
      ...context,
    }),
  );
  return clipError.stage;
}

/**
 * 失敗した配達の後始末。会話も翻訳も、同じ待ち行列の作法で終わらせる。
 *
 * 再試行しても変わらない失敗はここで捨て、それ以外は間隔を空けて戻す。
 * **何回で諦めるかは持たない。** `wrangler.jsonc`の`max_retries`が上限を握っていて、
 * 使い切った配達はqueue側が落とす。コードにもう1つ回数を置くと、二重管理になる。
 */
export function settleQueueFailure(
  message: Pick<Message<unknown>, 'attempts' | 'ack' | 'retry'>,
  error: ClipError,
  context: Record<string, unknown>,
): void {
  console.error(
    JSON.stringify({
      ...context,
      stage: error.stage,
      status: error.status,
      // 同じstageでも原因が複数あるため、どれで落ちたかをログから判別できるようにする。
      message: error.message,
      retryable: error.retryable,
      attempts: message.attempts,
    }),
  );
  if (!error.retryable) {
    message.ack();
    return;
  }
  message.retry({
    delaySeconds: Math.min(30 * 2 ** Math.max(0, message.attempts - 1), 900),
  });
}

export function asClipError(
  error: unknown,
  stage: ProcessingStage,
): ClipError {
  if (error instanceof ClipError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ClipError(message, stage, true, undefined, {
    cause: error instanceof Error ? error : undefined,
  });
}
