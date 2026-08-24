import { DurableObject } from 'cloudflare:workers';
import { alarmTime, expiresAt } from './retention';
import type { Env, SavedClip } from './types';

/** Slackスレッド1本ぶんの会話。モデル呼び出しはQueue consumer側に残す。 */
export class ThreadAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS turns (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           message TEXT NOT NULL,
           at TEXT NOT NULL,
           expires_at TEXT
         )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS handled (
           event_id TEXT PRIMARY KEY,
           reply TEXT NOT NULL,
           at TEXT NOT NULL,
           expires_at TEXT
         )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS handled_clips (
           event_id TEXT NOT NULL,
           path TEXT NOT NULL,
           title TEXT NOT NULL,
           PRIMARY KEY (event_id, path)
         )`,
      );
      this.addColumnIfMissing('turns', 'expires_at', 'TEXT');
      this.addColumnIfMissing('handled', 'expires_at', 'TEXT');
      // 旧rowも保存時刻から90日に揃える。
      ctx.storage.sql.exec(
        `UPDATE turns
            SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', at, '+90 days')
          WHERE expires_at IS NULL`,
      );
      ctx.storage.sql.exec(
        `UPDATE handled
            SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', at, '+90 days')
          WHERE expires_at IS NULL`,
      );
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS turns_expires_at ON turns (expires_at)',
      );
      ctx.storage.sql.exec(
        'CREATE INDEX IF NOT EXISTS handled_expires_at ON handled (expires_at)',
      );
      await this.deleteExpiredAndSchedule();
    });
  }

  async load(eventId: string): Promise<{ history: string[]; reply?: string; saved: SavedClip[] }> {
    await this.deleteExpiredAndSchedule();
    const history = this.ctx.storage.sql
      .exec<{ message: string }>('SELECT message FROM turns ORDER BY seq')
      .toArray()
      .map((row) => row.message);
    const saved = this.ctx.storage.sql
      .exec<{ path: string; title: string }>(
        'SELECT path, title FROM handled_clips WHERE event_id = ?',
        eventId,
      )
      .toArray();
    const reply = this.ctx.storage.sql
      .exec<{ reply: string }>('SELECT reply FROM handled WHERE event_id = ?', eventId)
      .toArray()[0]?.reply;
    return reply === undefined ? { history, saved } : { history, reply, saved };
  }

  async append(messages: string[]): Promise<void> {
    const at = new Date().toISOString();
    this.insertTurn(messages, at);
    await this.scheduleNextAlarm();
  }

  /** appendedに含まれるtool call/resultを同じ期限で保存する。 */
  async save(
    eventId: string,
    appended: string[],
    reply: string,
    saved: SavedClip[],
  ): Promise<void> {
    const at = new Date().toISOString();
    this.insertTurn(appended, at);
    this.ctx.storage.sql.exec(
      'INSERT INTO handled (event_id, reply, at, expires_at) VALUES (?, ?, ?, ?)',
      eventId,
      reply,
      at,
      expiresAt(at),
    );
    for (const clip of saved) {
      this.ctx.storage.sql.exec(
        'INSERT INTO handled_clips (event_id, path, title) VALUES (?, ?, ?)',
        eventId,
        clip.path,
        clip.title,
      );
    }
    await this.scheduleNextAlarm();
  }

  async alarm(): Promise<void> {
    await this.deleteExpiredAndSchedule();
  }

  private insertTurn(messages: string[], at: string): void {
    const expiry = expiresAt(at);
    for (const message of messages) {
      this.ctx.storage.sql.exec(
        'INSERT INTO turns (message, at, expires_at) VALUES (?, ?, ?)',
        message,
        at,
        expiry,
      );
    }
  }

  private addColumnIfMissing(table: 'turns' | 'handled', column: string, type: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray();
    if (!columns.some((value) => value.name === column)) {
      this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private async deleteExpiredAndSchedule(now = new Date().toISOString()): Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE FROM handled_clips
        WHERE event_id IN (SELECT event_id FROM handled WHERE expires_at <= ?)`,
      now,
    );
    this.ctx.storage.sql.exec('DELETE FROM handled WHERE expires_at <= ?', now);
    // 同じappend/saveの全messageは同じexpires_atなので、tool call/resultを分断しない。
    this.ctx.storage.sql.exec('DELETE FROM turns WHERE expires_at <= ?', now);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ expires_at: string }>(
        `SELECT MIN(expires_at) AS expires_at FROM (
           SELECT expires_at FROM turns WHERE expires_at IS NOT NULL
           UNION ALL
           SELECT expires_at FROM handled WHERE expires_at IS NOT NULL
         )`,
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
