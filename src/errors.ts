export type ProcessingStage =
  | 'validation'
  | 'fetch'
  | 'summary'
  | 'github'
  | 'slack';

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
