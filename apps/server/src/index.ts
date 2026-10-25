import { OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { AGENT_SCOPES } from "@workspace/core";
import { createMcpHandler } from "agents/mcp/server";
import { env as moduleEnv } from "cloudflare:workers";
import { buildApp } from "./app";
import { type AgentProps, createMcpServer } from "./mcp/server";
import { runScheduled } from "./scheduled";

export { PageDocument } from "./do/page";
export { WorkspaceChannel } from "./do/workspace";

const app = buildApp();

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const scopes = (ctx as OAuthResourceContext<AgentProps>).auth.scope;
      return createMcpHandler(() => createMcpServer(env, scopes), { route: "/mcp" })(request, env, ctx);
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

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => provider.fetch(request, env, ctx),
  scheduled: (controller: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(runScheduled(env)),
} satisfies ExportedHandler<Env>;
