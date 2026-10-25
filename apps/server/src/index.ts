import { insufficientScope, OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { AGENT_SCOPES } from "@workspace/core";
import { createMcpHandler } from "agents/mcp/server";
import { env as moduleEnv } from "cloudflare:workers";
import { buildApp } from "./app";
import { type AgentProps, createMcpServer, TOOL_SCOPES } from "./mcp/server";
import { runScheduled } from "./scheduled";

export { PageDocument } from "./do/page";
export { WorkspaceChannel } from "./do/workspace";

const app = buildApp();

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const auth = (ctx as OAuthResourceContext<AgentProps>).auth;
      const missing = await missingToolScopes(request, auth.scope);
      if (missing) return insufficientScope(auth, [...missing]);
      return createMcpHandler(() => createMcpServer(env, auth.scope), { route: "/mcp" })(request, env, ctx);
    },
  },
  defaultHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  // CIMD needs the Worker to fetch the client's metadata URL. chatgpt.com (Codex) answers workerd with 403,
  // so it is opt-in; dynamic client registration works for Claude Code and Codex.
  clientIdMetadataDocumentEnabled: moduleEnv.OAUTH_CIMD === "enabled",
  scopesSupported: [...AGENT_SCOPES, "offline_access"],
  requiredScopes: ["workspace:read"],
  resourceMetadata: { resource: `${moduleEnv.PUBLIC_URL}/mcp`, authorization_servers: [moduleEnv.PUBLIC_URL] },
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 60 * 60 * 24 * 30,
});

/** Per-tool step-up for every protocol version: a tools/call whose tool needs scopes the token lacks gets 403. */
async function missingToolScopes(request: Request, granted: string[]): Promise<readonly string[] | null> {
  if (request.method !== "POST") return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // malformed JSON is answered by the MCP handler
  }
  for (const msg of Array.isArray(body) ? body : [body]) {
    const m = msg as { method?: string; params?: { name?: string } };
    const needed = m?.method === "tools/call" && typeof m.params?.name === "string" ? TOOL_SCOPES[m.params.name] : undefined;
    if (needed && !needed.every((s) => granted.includes(s))) return needed;
  }
  return null;
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduled(env)),
} satisfies ExportedHandler<Env>;
