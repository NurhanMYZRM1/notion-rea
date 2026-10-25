import { agentCan, can, type Capability, type Role } from "@workspace/core";
import { AppError, forbidden, notFound } from "../errors";

/** Who is acting. Agents act for a person, limited by their grant's scopes. */
export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; userId: string; grantId: string; workspaceId: string; scopes: string[]; clientName: string };

export interface Access {
  workspaceId: string;
  role: Role;
  actor: Actor;
}

export async function roleOf(env: Env, workspaceId: string, userId: string): Promise<Role | null> {
  const row = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, userId)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

/**
 * The single authorization check used by REST, MCP and WebSocket entry points.
 * Membership is re-read on every call so removal takes effect immediately.
 */
export async function requireAccess(env: Env, actor: Actor, workspaceId: string, capability: Capability): Promise<Access> {
  if (actor.kind === "agent") {
    if (actor.workspaceId !== workspaceId) throw notFound("Workspace");
    const [role, grant] = await Promise.all([
      roleOf(env, workspaceId, actor.userId),
      env.DB.prepare("SELECT revoked_at FROM agent_grants WHERE id = ? AND user_id = ? AND workspace_id = ?")
        .bind(actor.grantId, actor.userId, workspaceId)
        .first<{ revoked_at: number | null }>(),
    ]);
    if (!grant || grant.revoked_at) throw new AppError("unauthenticated", "This agent connection was revoked");
    if (!role) throw new AppError("unauthenticated", "The person who authorized this agent is no longer a member");
    if (!agentCan(role, actor.scopes, capability)) throw forbidden(`Requires scope ${scopeFor(capability)} and a role that allows it`);
    return { workspaceId, role, actor };
  }
  const role = await roleOf(env, workspaceId, actor.userId);
  // Non-members get 404, not 403, so workspace and object ids are not confirmed to outsiders.
  if (!role) throw notFound("Workspace");
  if (!can(role, capability)) throw forbidden();
  return { workspaceId, role, actor };
}

function scopeFor(capability: Capability): string {
  return capability === "read" ? "workspace:read" : capability === "archive" ? "workspace:archive" : "workspace:write";
}

/** Resolve a page's workspace, then authorize. Unknown and foreign pages look identical (404). */
export async function requirePageAccess(
  env: Env,
  actor: Actor,
  pageId: string,
  capability: Capability,
): Promise<Access & { page: { id: string; workspace_id: string; state: string; database_id: string | null; is_database: number } }> {
  const page = await env.DB.prepare("SELECT id, workspace_id, state, database_id, is_database FROM pages WHERE id = ?")
    .bind(pageId)
    .first<{ id: string; workspace_id: string; state: string; database_id: string | null; is_database: number }>();
  if (!page || page.state === "deleted") throw notFound();
  try {
    const access = await requireAccess(env, actor, page.workspace_id, capability);
    return { ...access, page };
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") throw notFound();
    throw err;
  }
}

export function actorId(actor: Actor): string {
  return actor.kind === "agent" ? `agent:${actor.grantId}` : actor.userId;
}

export async function audit(
  env: Env,
  access: { workspaceId: string; actor: Actor },
  action: string,
  targetId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  const id = `ae_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    "INSERT INTO audit_events (id, workspace_id, actor_id, actor_type, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, access.workspaceId, access.actor.userId, access.actor.kind, action, targetId, detail ? JSON.stringify(detail) : null, Date.now())
    .run();
}
