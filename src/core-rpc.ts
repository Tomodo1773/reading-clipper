import { WorkerEntrypoint } from 'cloudflare:workers';
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

export interface McpAuditContext {
  source: 'mcp';
  /** Access identityの安定ID。認可には使わず、tokenやemailは渡さない。 */
  subject: string;
}

export interface CoreToolCall {
  name: CoreToolName;
  args: unknown;
}

/** Service Bindingのnamed entrypointだけに公開するCore RPC。 */
export class CoreMcpEntrypoint extends WorkerEntrypoint<Env> {
  async callTool(audit: McpAuditContext, call: CoreToolCall): Promise<CoreToolResult> {
    if (audit?.source !== 'mcp' || typeof audit.subject !== 'string' || !audit.subject) {
      throw new Error('invalid audit context');
    }
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
}
