import {
  createMcpHandler,
  hostHeaderValidationResponse,
  McpServer,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import type { CoreMcpEntrypoint } from './core-rpc';
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
 * Accessを通った本人だけを認める（ADR 0021）。
 *
 * `ctx.access`はCloudflareが検証済みのものなので、JWTの署名検証やJWKS取得はしない。
 * このWorkerは静的アセットを持たない。持たせると`ctx.access`が渡らなくなり、この照合が
 * 常に失敗する（ADR 0036）。
 */
export async function isAllowedIdentity(
  access: CloudflareAccessContext | undefined,
  env: McpEdgeEnv,
): Promise<boolean> {
  if (!access || !env.ACCESS_AUD || access.aud !== env.ACCESS_AUD) return false;
  try {
    const identity = await access.getIdentity();
    const email = identity?.email?.trim().toLowerCase();
    const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase();
    return Boolean(allowedEmail) && email === allowedEmail;
  } catch {
    return false;
  }
}

function createServer(env: McpEdgeEnv): McpServer {
  const server = new McpServer({ name: 'reading-clipper', version: '1.0.0' });
  const register = <K extends CoreToolName>(name: K) => {
    server.registerTool(
      name,
      {
        description: coreToolDescriptions[name],
        inputSchema: coreToolSchemas[name].shape,
      },
      async (args: Record<string, unknown>) => {
        const result = await env.CORE.callTool({ name, args });
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

/** 外部MCPクライアント向けのStreamable HTTP（ADR 0021）。この境界はこれだけを持つ。 */
const MCP_PATH = '/mcp';

export default {
  async fetch(request: Request, env: McpEdgeEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== MCP_PATH) {
      return new Response('Not found', { status: 404 });
    }
    const rejected =
      hostHeaderValidationResponse(request, [env.MCP_HOSTNAME]) ??
      originValidationResponse(request, [env.MCP_HOSTNAME]);
    if (rejected) return rejected;
    if (!(await isAllowedIdentity(ctx.access, env))) {
      return new Response('Forbidden', { status: 403 });
    }
    return createMcpHandler(() => createServer(env), { legacy: 'stateless' }).fetch(request);
  },
} satisfies ExportedHandler<McpEdgeEnv>;
