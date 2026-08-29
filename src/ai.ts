import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { ClipError } from './errors';
import type { Env } from './types';

/**
 * AI GatewayのGoogle AI Studioパススルーへ向ける。
 *
 * Geminiのキーはゲートウェイ側にStored Keys（BYOK）として置いてあり、Workerは持たない。
 * providerは`apiKey`を必須にしているためプレースホルダを渡し、実際に送る
 * `x-goog-api-key`はundefinedで落とす。認証は`cf-aig-authorization`だけで通る。
 */
export function createProvider(env: Env) {
  return createGoogleGenerativeAI({
    baseURL: `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/google-ai-studio/v1beta`,
    apiKey: 'stored-by-ai-gateway',
    headers: {
      'x-goog-api-key': undefined,
      'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
  });
}

/**
 * モデル呼び出しの失敗を`ClipError`へ落として投げ直す。
 *
 * AI SDKは内部再試行を使い切るとAPICallErrorではなくRetryErrorを投げる。
 * 中身を出さずに素通りさせると、stage・status・retryableの分類が全部落ちる（ADR 0008）。
 *
 * 会話も翻訳も同じ`chat`段階として扱う。呼び出しの形も失敗の仕方も同じなので、
 * 段階を分けてもログの読み方が増えるだけになる（ADR 0027）。
 */
export function throwModelCallError(error: unknown): never {
  const failure = RetryError.isInstance(error) ? error.lastError : error;
  // ステータスだけでは何を拒否されたか分からない。ゲートウェイの返す理由をログへ残す。
  if (APICallError.isInstance(failure)) {
    throw new ClipError(
      `${failure.message}: ${(failure.responseBody ?? '').slice(0, 600)}`,
      'chat',
      failure.isRetryable,
      failure.statusCode,
      { cause: failure },
    );
  }
  // 中身を分類できなくても、モデル呼び出しで落ちたことだけは残す。
  if (RetryError.isInstance(error)) {
    throw new ClipError(error.message, 'chat', true, undefined, { cause: error });
  }
  throw error;
}
