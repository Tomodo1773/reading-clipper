export const RETENTION_DAYS = 90;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function expiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + RETENTION_MS).toISOString();
}

export function alarmTime(value: string): number {
  return Date.parse(value);
}
