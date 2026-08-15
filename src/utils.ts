import { ClipError, isRetryableStatus, type ProcessingStage } from './errors';

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  stage: ProcessingStage,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ClipError('external request failed', stage, true, undefined, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function assertOk(response: Response, stage: ProcessingStage): void {
  if (response.ok) return;
  throw new ClipError(
    `external request returned ${response.status}`,
    stage,
    isRetryableStatus(response.status),
    response.status,
  );
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
  return [...(await sha256Bytes(value))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(value));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
