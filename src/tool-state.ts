import { DurableObject } from 'cloudflare:workers';
import type { Env, FetchedContent } from './types';

export interface ClipRefPayload {
  path: string;
  title: string;
}

/**
 * ownerごとのtool ref（ADR 0038）。
 *
 * 取得した本文はURLごと、保存済みクリップはパスごとに1行で、refはその行に固定で付く。
 * 同じURLを読み直せば本文だけ差し替わり、refは変わらない。期限は持たない。
 * 2つの表を分けているのは、取得のrefで削除へ、検索のrefで保存へ届かせないためである。
 */
export class ToolState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS loaded (
           url TEXT PRIMARY KEY,
           ref TEXT NOT NULL UNIQUE,
           content_json TEXT NOT NULL
         )`,
      );
      ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS clips (
           path TEXT PRIMARY KEY,
           ref TEXT NOT NULL UNIQUE,
           title TEXT NOT NULL
         )`,
      );
    });
  }

  putLoaded(content: FetchedContent): string {
    return this.ctx.storage.sql
      .exec<{ ref: string }>(
        `INSERT INTO loaded (url, ref, content_json) VALUES (?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET content_json = excluded.content_json
         RETURNING ref`,
        content.canonicalUrl,
        crypto.randomUUID(),
        JSON.stringify(content),
      )
      .one().ref;
  }

  /**
   * 候補のぶんだけrefをまとめて返す。1件ずつの口は持たない。
   *
   * 検索も一覧も複数の候補を一度に返すため、単発の口を残すと呼び出し側が件数ぶんの
   * RPC往復を作れてしまう（ADR 0031）。
   */
  putClips(payloads: ClipRefPayload[]): string[] {
    return payloads.map(
      ({ path, title }) =>
        this.ctx.storage.sql
          .exec<{ ref: string }>(
            `INSERT INTO clips (path, ref, title) VALUES (?, ?, ?)
             ON CONFLICT (path) DO UPDATE SET title = excluded.title
             RETURNING ref`,
            path,
            crypto.randomUUID(),
            title,
          )
          .one().ref,
    );
  }

  resolveLoaded(ref: string): FetchedContent | null {
    const row = this.ctx.storage.sql
      .exec<{ content_json: string }>('SELECT content_json FROM loaded WHERE ref = ?', ref)
      .toArray()[0];
    return row ? (JSON.parse(row.content_json) as FetchedContent) : null;
  }

  resolveClip(ref: string): ClipRefPayload | null {
    const row = this.ctx.storage.sql
      .exec<{ path: string; title: string }>('SELECT path, title FROM clips WHERE ref = ?', ref)
      .toArray()[0];
    return row ? { path: row.path, title: row.title } : null;
  }
}
