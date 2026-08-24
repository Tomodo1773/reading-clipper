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

export async function getAccessAuditContext(
  access: CloudflareAccessContext | undefined,
  env: McpEdgeEnv,
): Promise<McpAuditContext | undefined> {
  if (!access || !env.ACCESS_AUD || access.aud !== env.ACCESS_AUD) return undefined;
  try {
    const identity = await access.getIdentity();
    const email = identity?.email?.trim().toLowerCase();
    const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim().toLowerCase();
    if (!identity?.user_uuid || !allowedEmail || email !== allowedEmail) return undefined;
    return { source: 'mcp', subject: identity.user_uuid };
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

export default {
  async fetch(request: Request, env: McpEdgeEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const rejected =
      hostHeaderValidationResponse(request, [env.MCP_HOSTNAME]) ??
      originValidationResponse(request, [env.MCP_HOSTNAME]);
    if (rejected) return rejected;
    const audit = await getAccessAuditContext(ctx.access, env);
    if (!audit) return new Response('Forbidden', { status: 403 });
    return createMcpHandler(() => createServer(env, audit), { legacy: 'stateless' }).fetch(request);
  },
} satisfies ExportedHandler<McpEdgeEnv>;
