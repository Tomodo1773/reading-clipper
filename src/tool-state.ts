import { DurableObject } from 'cloudflare:workers';
import { alarmTime, expiresAt } from './retention';
import type { Env, FetchedContent } from './types';

export interface ClipRefPayload {
  path: string;
  title: string;
}

export type ToolRefKind = 'loaded' | 'clip';
export type ToolRefPayload = FetchedContent | ClipRefPayload;

export type ResolveRefResult<T> =
  | { ok: true; payload: T }
  | { ok: false; error: 'unknown_ref' | 'wrong_kind' | 'expired' };

interface StoredRef extends Record<string, string> {
  kind: ToolRefKind;
  payload_json: string;
  expires_at: string;
}

/** ownerごとのopaque tool refだけを保持する（ADR 0022）。 */
export class ToolState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS tool_refs (
           ref TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           expires_at TEXT NOT NULL
         )`,
      );
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS tool_refs_expires_at ON tool_refs (expires_at)',
      );
      await this.deleteExpiredAndSchedule();
    });
  }

  async putLoaded(content: FetchedContent, createdAt = new Date().toISOString()): Promise<string> {
    const [ref] = await this.put('loaded', [content], createdAt);
    return ref as string;
  }

  /**
   * 候補のぶんだけrefをまとめて発行する。1件ずつ発行する口は持たない。
   *
   * 検索も一覧も複数の候補を一度に返すため、単発の口を残すと呼び出し側が件数ぶんの
   * RPC往復を作れてしまう（ADR 0031）。
   */
  async putClips(
    payloads: ClipRefPayload[],
    createdAt = new Date().toISOString(),
  ): Promise<string[]> {
    return this.put('clip', payloads, createdAt);
  }

  resolveLoaded(ref: string, now = new Date().toISOString()): ResolveRefResult<FetchedContent> {
    return this.resolve(ref, 'loaded', now);
  }

  resolveClip(ref: string, now = new Date().toISOString()): ResolveRefResult<ClipRefPayload> {
    return this.resolve(ref, 'clip', now);
  }

  async alarm(): Promise<void> {
    await this.deleteExpiredAndSchedule();
  }

  private async put(
    kind: ToolRefKind,
    payloads: ToolRefPayload[],
    createdAt: string,
  ): Promise<string[]> {
    const expires = expiresAt(createdAt);
    const refs = payloads.map((payload) => {
      const ref = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO tool_refs (ref, kind, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        ref,
        kind,
        JSON.stringify(payload),
        createdAt,
        expires,
      );
      return ref;
    });
    if (refs.length > 0) await this.scheduleNextAlarm();
    return refs;
  }

  private resolve<T>(ref: string, kind: ToolRefKind, now: string): ResolveRefResult<T> {
    const row = this.ctx.storage.sql
      .exec<StoredRef>(
        'SELECT kind, payload_json, expires_at FROM tool_refs WHERE ref = ?',
        ref,
      )
      .toArray()[0];
    if (!row) return { ok: false, error: 'unknown_ref' };
    if (row.kind !== kind) return { ok: false, error: 'wrong_kind' };
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec('DELETE FROM tool_refs WHERE ref = ?', ref);
      this.ctx.waitUntil(this.scheduleNextAlarm());
      return { ok: false, error: 'expired' };
    }
    return { ok: true, payload: JSON.parse(row.payload_json) as T };
  }

  private async deleteExpiredAndSchedule(now = new Date().toISOString()): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM tool_refs WHERE expires_at <= ?', now);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ expires_at: string }>(
        'SELECT expires_at FROM tool_refs ORDER BY expires_at LIMIT 1',
      )
      .toArray()[0]?.expires_at;
    const current = await this.ctx.storage.getAlarm();
    if (!next) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const target = alarmTime(next);
    if (current === null || current !== target) await this.ctx.storage.setAlarm(target);
  }
}
