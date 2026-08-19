import { DurableObject } from 'cloudflare:workers';
import type { Env, SavedClip } from './types';

/**
 * Slackのスレッド1本ぶんの会話（ADR 0007）。`{channel}:{thread_ts}` で引く。
 *
 * 持つのは会話の読み書きだけで、モデルの呼び出しはQueue consumer側で行う（ADR 0008）。
 * 会話はモデルへ渡す形のまま、ツール呼び出しとその結果を含めて追記していく。
 * 記事本文はツール結果の中に残るため、2ターン目以降に取得も読み直しも行わない。
 */
export class ThreadAgent extends DurableObject<Env> {
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
      // そのターンで保存できたクリップ。再試行では返信を投げ直すだけでモデルを動かさないため、
      // ここに残しておかないと、投稿し直した返信からボタンだけが落ちる（ADR 0015）。
      // `handled`へ列を足さず表を分けるのは、既にあるDOへは`ALTER`が要るため。
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS handled_clips (
           event_id TEXT NOT NULL,
           path TEXT NOT NULL,
           title TEXT NOT NULL,
           PRIMARY KEY (event_id, path)
         )`,
      );
    });
  }

  /**
   * これまでの会話と、このイベントを処理済みなら書き上げてある返信を返す。
   *
   * 会話はJSON文字列のまま受け渡す。`ModelMessage`はunionが深く、RPCの型解決が発散するため。
   * `saved`はその返信に付けるボタンの材料で、素の構造なのでそのまま返す。
   */
  load(eventId: string): { history: string[]; reply?: string; saved: SavedClip[] } {
    const history = this.ctx.storage.sql
      .exec<{ message: string }>('SELECT message FROM turns ORDER BY seq')
      .toArray()
      .map((row) => row.message);
    const saved = this.ctx.storage.sql
      .exec<{
        path: string;
        title: string;
      }>('SELECT path, title FROM handled_clips WHERE event_id = ?', eventId)
      .toArray();
    const reply = this.ctx.storage.sql
      .exec<{ reply: string }>('SELECT reply FROM handled WHERE event_id = ?', eventId)
      .toArray()[0]?.reply;
    return reply === undefined ? { history, saved } : { history, reply, saved };
  }

  /**
   * 会話へ書き足すだけ。Slackのイベントに紐づかない書き込みに使う。
   * 週次ダイジェストは、投稿した内容をこれでスレッドの文脈にする（ADR 0010）。
   */
  append(messages: string[]): void {
    const at = new Date().toISOString();
    for (const message of messages) {
      this.ctx.storage.sql.exec('INSERT INTO turns (message, at) VALUES (?, ?)', message, at);
    }
  }

  /** 1ターンぶんをまとめて書く。途中で落ちたターンは何も残さない。 */
  save(eventId: string, appended: string[], reply: string, saved: SavedClip[] = []): void {
    const at = new Date().toISOString();
    this.append(appended);
    this.ctx.storage.sql.exec(
      'INSERT INTO handled (event_id, reply, at) VALUES (?, ?, ?)',
      eventId,
      reply,
      at,
    );
    for (const clip of saved) {
      this.ctx.storage.sql.exec(
        'INSERT INTO handled_clips (event_id, path, title) VALUES (?, ?, ?)',
        eventId,
        clip.path,
        clip.title,
      );
    }
  }
}
