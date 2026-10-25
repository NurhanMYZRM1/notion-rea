import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type AgentGrantInfo, newId } from "@workspace/core";
import { notFound } from "../errors";
import { audit } from "./access";

export async function createGrant(
  env: Env,
  g: { userId: string; workspaceId: string; clientId: string; clientName: string; scopes: string[] },
): Promise<string> {
  const id = newId("ag");
  await env.DB.prepare(
    "INSERT INTO agent_grants (id, workspace_id, user_id, client_id, client_name, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, g.workspaceId, g.userId, g.clientId, g.clientName.slice(0, 200), g.scopes.join(" "), Date.now())
    .run();
  await audit(env, { workspaceId: g.workspaceId, actor: { kind: "user", userId: g.userId } }, "agent.grant", id, { client: g.clientName.slice(0, 100), scopes: g.scopes });
  return id;
}

export async function listGrants(env: Env, userId: string): Promise<(AgentGrantInfo & { workspaceName: string })[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.client_name, g.client_id, g.workspace_id, w.name AS workspace_name, g.scopes, g.created_at, g.last_used_at
     FROM agent_grants g JOIN workspaces w ON w.id = g.workspace_id
     WHERE g.user_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 100`,
  )
    .bind(userId)
    .all<{ id: string; client_name: string; client_id: string; workspace_id: string; workspace_name: string; scopes: string; created_at: number; last_used_at: number | null }>();
  return rows.results.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    scopes: r.scopes.split(" "),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Revoke an agent connection. D1 is authoritative (checked on every MCP call); tokens are also revoked. */
export async function revokeGrant(env: Env & { OAUTH_PROVIDER?: OAuthHelpers }, userId: string, grantId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT workspace_id FROM agent_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(grantId, userId)
    .first<{ workspace_id: string }>();
  if (!row) throw notFound("Agent connection");
  await env.DB.prepare("UPDATE agent_grants SET revoked_at = ? WHERE id = ?").bind(Date.now(), grantId).run();
  await audit(env, { workspaceId: row.workspace_id, actor: { kind: "user", userId } }, "agent.revoke", grantId);
  if (env.OAUTH_PROVIDER) {
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor });
      for (const g of page.items) {
        if ((g.metadata as { grantId?: string } | undefined)?.grantId === grantId) await env.OAUTH_PROVIDER.revokeGrant(g.id, userId);
      }
      cursor = page.cursor;
    } while (cursor);
  }
}

export async function touchGrant(env: Env, grantId: string): Promise<void> {
  const t = Date.now();
  await env.DB.prepare("UPDATE agent_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
    .bind(t, grantId, t - 60_000)
    .run();
}
