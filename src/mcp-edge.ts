import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { CoreMcpEntrypoint, McpAuditContext } from './core-rpc';
import {
  coreToolDescriptions,
  coreToolNames,
  coreToolSchemas,
  type CoreToolName,
} from './tool-contract';

export interface McpEdgeEnv {
  CORE: Service<CoreMcpEntrypoint>;
  ACCESS_AUD: string;
  ACCESS_ALLOWED_EMAIL: string;
  MCP_HOSTNAME: string;
}

/**
 * Accessを通った本人だけを認め、監査に渡せる安定IDを返す。
 * どの入口から来たかは呼び出し側が名乗る（ADR 0030）。
 */
export async function getAccessSubject(
  access: CloudflareAccessContext | undefined,
  env: McpEdgeEnv,
): Promise<string | undefined> {
  if (!access || !env.ACCESS_AUD || access.aud !== env.ACCESS_AUD) return undefined;
  try {
    const identity = await access.getIdentity();
    const email = identity?.email?.trim().toLowerCase();
    const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase();
    if (!identity?.user_uuid || !allowedEmail || email !== allowedEmail) return undefined;
    return identity.user_uuid;
  } catch {
    return undefined;
  }
}

function createServer(env: McpEdgeEnv, audit: McpAuditContext): McpServer {
  const server = new McpServer({ name: 'reading-clipper', version: '1.0.0' });
  const register = <K extends CoreToolName>(name: K) => {
    server.registerTool(
      name,
      {
        description: coreToolDescriptions[name],
        inputSchema: coreToolSchemas[name].shape,
      },
      async (args: Record<string, unknown>) => {
        const result = await env.CORE.callTool(audit, {
          name,
          args,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
  };
  for (const name of coreToolNames) register(name);
  return server;
}

/** 外部MCPクライアント向けのStreamable HTTP（ADR 0021）。 */
const MCP_PATH = '/mcp';

/** 自分がブラウザから開くクリップ一覧（ADR 0030、ADR 0032、ADR 0033）。 */
const CLIP_PAGE_PATH = '/clips';

/** 一覧の未片付けカードから、1件だけ片付ける入口（ADR 0033）。 */
const CLIP_DISMISS_PATH = '/clips/dismiss';

/**
 * 閲覧ページの防御をエスケープ1枚に頼らない（ADR 0030）。
 *
 * 抜粋は記事本文から作る外部由来の文字列で、エスケープを外すと注入になる。このページは
 * スクリプトを1行も持たず、外へ読みに行くのはサムネイルだけなので、`script-src`を落として
 * おけばエスケープが漏れても実行に繋がらない。CSSは`<style>`で埋めているため`style-src`
 * だけはinlineを許す。
 */
const CLIP_PAGE_CSP =
  "default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'self'";

export default {
  async fetch(request: Request, env: McpEdgeEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const servesClipPage = pathname === CLIP_PAGE_PATH && request.method === 'GET';
    const dismissesClip = pathname === CLIP_DISMISS_PATH && request.method === 'POST';
    if (pathname !== MCP_PATH && !servesClipPage && !dismissesClip) {
      return new Response('Not found', { status: 404 });
    }
    // Originが無いリクエストは通る実装なので、ブラウザの通常の遷移もそのまま抜ける。
    // 入口ごとに緩めない。
    const rejected =
      hostHeaderValidationResponse(request, [env.MCP_HOSTNAME]) ??
      originValidationResponse(request, [env.MCP_HOSTNAME]);
    if (rejected) return rejected;
    // 通常のページ遷移と違い、状態を変えるform POSTにはOriginが付く。
    // 無いものを許すと、既存のOrigin検証を迂回して別サイトから送れる。
    if (dismissesClip && !request.headers.get('origin')) {
      return new Response('Forbidden', { status: 403 });
    }
    const subject = await getAccessSubject(ctx.access, env);
    if (!subject) return new Response('Forbidden', { status: 403 });
    if (servesClipPage) {
      return new Response(await env.CORE.clipPage({ source: 'web', subject }), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Accessの後ろにある個人的な一覧なので、共有キャッシュにも履歴にも残さない。
          'cache-control': 'private, no-store',
          'content-security-policy': CLIP_PAGE_CSP,
        },
      });
    }
    if (dismissesClip) {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const args = coreToolSchemas.set_clip_dismissed.safeParse({
        path: form.get('path'),
        dismissed: true,
      });
      if (!args.success) return new Response('Bad request', { status: 400 });

      const result = await env.CORE.callTool(
        { source: 'web', subject },
        { name: 'set_clip_dismissed', args: args.data },
      );
      if ('updated' in result && result.updated) {
        return new Response(null, {
          status: 303,
          headers: { location: CLIP_PAGE_PATH, 'cache-control': 'private, no-store' },
        });
      }
      return new Response('Clip could not be dismissed', {
        status: 'unknown_path' in result ? 404 : 500,
      });
    }
    return createMcpHandler(() => createServer(env, { source: 'mcp', subject }), {
      legacy: 'stateless',
    }).fetch(request);
  },
} satisfies ExportedHandler<McpEdgeEnv>;
