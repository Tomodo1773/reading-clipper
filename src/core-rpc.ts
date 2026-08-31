import { WorkerEntrypoint } from 'cloudflare:workers';
import { buildClipPage } from './clip-index';
import type { CoreToolName } from './tool-contract';
import {
  deleteClipTool,
  findClipsTool,
  loadContentTool,
  readClipTool,
  saveLoadedTool,
  setClipDismissedTool,
  type CoreToolResult,
} from './tools';
import type { Env } from './types';

/**
 * 公開境界のどの入口から来たかの記録（ADR 0021、ADR 0030）。
 * 認可には使わない。値で処理を分けないこと。
 */
export type AuditSource = 'mcp' | 'web';

export interface McpAuditContext {
  source: AuditSource;
  /** Access identityの安定ID。認可には使わず、tokenやemailは渡さない。 */
  subject: string;
}

const AUDIT_SOURCES: readonly string[] = ['mcp', 'web'];

/**
 * 呼び出し元がAccessを通っていることの印だけを確かめる。ownerは常に自分の設定から取る。
 */
function requireAudit(audit: McpAuditContext): void {
  if (!AUDIT_SOURCES.includes(audit?.source) || typeof audit?.subject !== 'string' || !audit.subject) {
    throw new Error('invalid audit context');
  }
}

export interface CoreToolCall {
  name: CoreToolName;
  args: unknown;
}

/** Service Bindingのnamed entrypointだけに公開するCore RPC。 */
export class CoreMcpEntrypoint extends WorkerEntrypoint<Env> {
  async callTool(audit: McpAuditContext, call: CoreToolCall): Promise<CoreToolResult> {
    requireAudit(audit);
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
      case 'read_clip':
        return readClipTool(this.env, ownerId, call.args);
      case 'delete_clip':
        return deleteClipTool(this.env, ownerId, call.args);
      default:
        throw new Error('unknown tool');
    }
  }

  /**
   * 閲覧ページのHTML（ADR 0030）。ツール契約には載せない。
   *
   * `callTool`は外部MCPクライアントへ公開するツールを通す口である。画面のための
   * 取得をそこへ足すと、別のSlack Botに「一覧を返すツール」が生えることになる。
   */
  async renderClipPage(audit: McpAuditContext): Promise<string> {
    requireAudit(audit);
    return buildClipPage(this.env);
  }
}
