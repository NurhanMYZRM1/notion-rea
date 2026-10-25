import { CreateInvitationInput, type InvitationInfo, type MemberInfo, newId, type Role, UpdateMemberInput, type WorkspaceInfo } from "@workspace/core";
import { AppError, forbidden, notFound } from "../errors";
import { randomToken, sha256Hex } from "../util";
import { type Actor, audit, requireAccess, roleOf } from "./access";
import { page, publish } from "./pages";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function listWorkspaces(env: Env, userId: string): Promise<WorkspaceInfo[]> {
  const rows = await env.DB.prepare(
    "SELECT w.id, w.name, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at",
  )
    .bind(userId)
    .all<WorkspaceInfo>();
  return rows.results;
}

export async function renameWorkspace(env: Env, actor: Actor, workspaceId: string, name: string): Promise<void> {
  const access = await requireAccess(env, actor, workspaceId, "manage_members");
  const clean = name.trim().slice(0, 100);
  if (!clean) throw new AppError("invalid_input", "Name is required");
  await env.DB.prepare("UPDATE workspaces SET name = ? WHERE id = ?").bind(clean, workspaceId).run();
  await audit(env, access, "workspace.rename", workspaceId);
  await publish(env, workspaceId, [["workspaces"]]);
}

export async function listMembers(env: Env, actor: Actor, workspaceId: string): Promise<MemberInfo[]> {
  await requireAccess(env, actor, workspaceId, "read");
  const rows = await env.DB.prepare(
    `SELECT m.user_id AS userId, u.name, u.email, u.image, m.role, m.created_at AS joinedAt
     FROM members m JOIN "user" u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at LIMIT 500`,
  )
    .bind(workspaceId)
    .all<MemberInfo>();
  return rows.results;
}

function invitationStatus(r: { accepted_at: number | null; revoked_at: number | null; expires_at: number }): InvitationInfo["status"] {
  if (r.accepted_at) return "accepted";
  if (r.revoked_at) return "revoked";
  return r.expires_at < Date.now() ? "expired" : "pending";
}

export async function listInvitations(env: Env, actor: Actor, workspaceId: string): Promise<InvitationInfo[]> {
  await requireAccess(env, actor, workspaceId, "manage_members");
  const rows = await env.DB.prepare(
    "SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200",
  )
    .bind(workspaceId)
    .all<{ id: string; email: string; role: Role; created_at: number; expires_at: number; accepted_at: number | null; revoked_at: number | null }>();
  return rows.results.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at, status: invitationStatus(r) }));
}

/** Create an invitation. The raw token is returned once (for the copyable link); only its hash is stored. */
export async function createInvitation(
  env: Env,
  actor: Actor,
  workspaceId: string,
  raw: unknown,
): Promise<{ invitation: InvitationInfo; url: string }> {
  const access = await requireAccess(env, actor, workspaceId, "manage_members");
  const input = CreateInvitationInput.parse(raw);
  const token = randomToken();
  const id = newId("inv");
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO invitations (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, workspaceId, input.email, input.role, await sha256Hex(token), actor.userId, t, t + INVITE_TTL_MS)
    .run();
  await audit(env, access, "invitation.create", id, { role: input.role });
  return {
    invitation: { id, email: input.email, role: input.role, createdAt: t, expiresAt: t + INVITE_TTL_MS, status: "pending" },
    url: `${env.PUBLIC_URL}/invite#${token}`,
  };
}

export async function revokeInvitation(env: Env, actor: Actor, workspaceId: string, invitationId: string): Promise<void> {
  const access = await requireAccess(env, actor, workspaceId, "manage_members");
  await env.DB.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL")
    .bind(Date.now(), invitationId, workspaceId)
    .run();
  await audit(env, access, "invitation.revoke", invitationId);
}

/**
 * Accept an invitation. Requires a signed-in user whose *verified* email equals the invited email.
 * Single use: the conditional UPDATE claims the invitation atomically.
 */
export async function acceptInvitation(
  env: Env,
  user: { id: string; email: string; emailVerified: boolean },
  token: string,
): Promise<{ workspaceId: string; role: Role }> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new AppError("invalid_input", "Invalid invitation link");
  const hash = await sha256Hex(token);
  const inv = await env.DB.prepare(
    "SELECT id, workspace_id, email, role, expires_at, accepted_at, accepted_by, revoked_at FROM invitations WHERE token_hash = ?",
  )
    .bind(hash)
    .first<{ id: string; workspace_id: string; email: string; role: Role; expires_at: number; accepted_at: number | null; accepted_by: string | null; revoked_at: number | null }>();
  if (!inv) throw notFound("Invitation");
  if (inv.accepted_at) {
    if (inv.accepted_by === user.id) return { workspaceId: inv.workspace_id, role: inv.role };
    throw new AppError("gone", "This invitation has already been used");
  }
  if (inv.revoked_at) throw new AppError("gone", "This invitation was revoked");
  if (inv.expires_at < Date.now()) throw new AppError("gone", "This invitation has expired; ask for a new one");
  if (!user.emailVerified || user.email.toLowerCase() !== inv.email.toLowerCase()) {
    throw forbidden(`This invitation is for a different account. Sign in with ${maskEmail(inv.email)}.`);
  }
  const t = Date.now();
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at >= ?",
    ).bind(t, user.id, inv.id, t),
    // Only takes effect if the claim above succeeded (same batch = one transaction).
    env.DB.prepare(
      `INSERT INTO members (workspace_id, user_id, role, created_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invitations WHERE id = ? AND accepted_by = ? AND accepted_at = ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = CASE WHEN members.role = 'owner' THEN 'owner' ELSE excluded.role END`,
    ).bind(inv.workspace_id, user.id, inv.role, t, inv.id, user.id, t),
  ]);
  if (!claim!.meta.changes) throw new AppError("gone", "This invitation has already been used");
  await audit(env, { workspaceId: inv.workspace_id, actor: { kind: "user", userId: user.id } }, "member.join", user.id, { role: inv.role });
  await publish(env, inv.workspace_id, [["members"]]);
  // Report the role actually held: an existing owner keeps ownership when accepting a lesser invitation.
  return { workspaceId: inv.workspace_id, role: (await roleOf(env, inv.workspace_id, user.id)) ?? inv.role };
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name!.slice(0, 2)}***@${domain}`;
}

async function ownerCount(env: Env, workspaceId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner'").bind(workspaceId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function updateMember(env: Env, actor: Actor, workspaceId: string, userId: string, raw: unknown): Promise<void> {
  const access = await requireAccess(env, actor, workspaceId, "manage_members");
  const { role } = UpdateMemberInput.parse(raw);
  const current = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first<{ role: Role }>();
  if (!current) throw notFound("Member");
  if (current.role === "owner" && role !== "owner" && (await ownerCount(env, workspaceId)) <= 1) {
    throw new AppError("conflict", "A workspace needs at least one owner");
  }
  await env.DB.prepare("UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(role, workspaceId, userId).run();
  await audit(env, access, "member.role", userId, { role });
  await publish(env, workspaceId, [["members"]]);
}

/**
 * Remove a member (or leave). Revokes their agent grants and closes their live document and event
 * sockets; subsequent requests fail the membership check.
 */
export async function removeMember(env: Env, actor: Actor, workspaceId: string, userId: string): Promise<void> {
  const self = actor.userId === userId;
  const access = await requireAccess(env, actor, workspaceId, self ? "read" : "manage_members");
  const current = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId).first<{ role: Role }>();
  if (!current) throw notFound("Member");
  if (current.role === "owner" && (await ownerCount(env, workspaceId)) <= 1) throw new AppError("conflict", "A workspace needs at least one owner");
  const sessions = await env.DB.prepare("SELECT page_id FROM doc_sessions WHERE user_id = ? AND workspace_id = ?").bind(userId, workspaceId).all<{ page_id: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
    env.DB.prepare("UPDATE agent_grants SET revoked_at = ? WHERE workspace_id = ? AND user_id = ? AND revoked_at IS NULL").bind(Date.now(), workspaceId, userId),
    env.DB.prepare("DELETE FROM favorites WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
    env.DB.prepare("DELETE FROM recents WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
    env.DB.prepare("DELETE FROM doc_sessions WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, userId),
  ]);
  await Promise.allSettled([
    ...sessions.results.map((s) => page(env, s.page_id).revokeUser(userId)),
    env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)).revokeUser(userId),
  ]);
  await audit(env, access, self ? "member.leave" : "member.remove", userId);
  await publish(env, workspaceId, [["members"]]);
}

/**
 * Account deletion: leaves every workspace (refused while the user is the last owner of one),
 * revokes grants, closes sockets, and deletes the Better Auth user (sessions/accounts cascade).
 * Pages they created stay with the workspace.
 */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  const memberships = await env.DB.prepare("SELECT workspace_id, role FROM members WHERE user_id = ?").bind(userId).all<{ workspace_id: string; role: Role }>();
  for (const m of memberships.results) {
    if (m.role === "owner" && (await ownerCount(env, m.workspace_id)) <= 1) {
      throw new AppError("conflict", "Transfer ownership before deleting your account: you are the only owner of a workspace", { workspaceId: m.workspace_id });
    }
  }
  for (const m of memberships.results) await removeMember(env, { kind: "user", userId }, m.workspace_id, userId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM agent_grants WHERE user_id = ?").bind(userId),
    env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(userId),
  ]);
}
