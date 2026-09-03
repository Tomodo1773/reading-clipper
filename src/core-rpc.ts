import { WorkerEntrypoint } from 'cloudflare:workers';
import { buildClipPage, buildClipReadPage } from './clip-page';
import type { CoreToolName } from './tool-contract';
import {
  deleteClipTool,
  findClipsTool,
  listClipsTool,
  loadContentTool,
  readClipTool,
  saveLoadedTool,
  setClipDismissedTool,
  type CoreToolResult,
} from './tools';
import type { Env } from './types';

export interface CoreToolCall {
  name: CoreToolName;
  args: unknown;
}

/**
 * MCP境界だけに公開するCore RPC（ADR 0021）。Service Bindingからだけ到達する。
 * ownerは常にCore自身の設定から取り、呼び出し側からは受け取らない。
 */
export class CoreMcpEntrypoint extends WorkerEntrypoint<Env> {
  async callTool(call: CoreToolCall): Promise<CoreToolResult> {
    const ownerId = this.env.TOOL_OWNER_ID;
    const receivedAt = new Date().toISOString();
    switch (call?.name) {
      case 'load_content':
        return loadContentTool(this.env, ownerId, call.args);
      case 'save_loaded':
        return saveLoadedTool(this.env, ownerId, receivedAt, call.args);
      case 'set_clip_dismissed':
        return setClipDismissedTool(this.env, receivedAt, call.args);
      case 'find_clips':
        return findClipsTool(this.env, ownerId, call.args);
      case 'list_clips':
        return listClipsTool(this.env, ownerId, call.args);
      case 'read_clip':
        return readClipTool(this.env, ownerId, call.args);
      case 'delete_clip':
        return deleteClipTool(this.env, ownerId, call.args);
      default:
        throw new Error('unknown tool');
    }
  }
}

/**
 * 閲覧ページのWorkerだけに公開するCore RPC（ADR 0036）。
 *
 * 一覧・本文・片付けの3つに限る。ツール契約には載せない。`callTool`は外部MCP
 * クライアントへ公開するツールを通す口なので、画面のための取得をそこへ足すと、
 * 別のSlack Botに「一覧を返すツール」が生えることになる。
 */
export class CoreWebEntrypoint extends WorkerEntrypoint<Env> {
  /** 一覧のHTML（ADR 0030、ADR 0032）。 */
  async clipPage(): Promise<string> {
    return buildClipPage(this.env);
  }

  /** 保存した本文のHTML（ADR 0034）。無いクリップでは`undefined`を返す。 */
  async clipReadPage(path: string): Promise<string | undefined> {
    return buildClipReadPage(this.env, path);
  }

  /** カードから1件だけ片付ける（ADR 0033）。印を外す操作はここへ出さない。 */
  async dismissClip(path: string) {
    return setClipDismissedTool(this.env, new Date().toISOString(), { path, dismissed: true });
  }
}
