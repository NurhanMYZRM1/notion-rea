import { type CommentInfo, CreateCommentInput, newId } from "@workspace/core";
import { AppError, notFound } from "../errors";
import { type Actor, actorId, audit, requirePageAccess } from "./access";
import { publish } from "./pages";

export async function listComments(env: Env, actor: Actor, pageId: string, before: number | null, limit = 50): Promise<CommentInfo[]> {
  await requirePageAccess(env, actor, pageId, "read");
  const rows = await env.DB.prepare(
    `SELECT c.id, c.page_id, c.body, c.created_at, c.author_id, c.author_type, u.name, u.image
     FROM comments c LEFT JOIN "user" u ON u.id = c.author_id
     WHERE c.page_id = ? AND c.deleted_at IS NULL AND (? IS NULL OR c.created_at < ?)
     ORDER BY c.created_at DESC LIMIT ?`,
  )
    .bind(pageId, before, before, Math.min(limit, 100))
    .all<{ id: string; page_id: string; body: string; created_at: number; author_id: string; author_type: string; name: string | null; image: string | null }>();
  return rows.results.reverse().map((r) => ({
    id: r.id,
    pageId: r.page_id,
    body: r.body,
    createdAt: r.created_at,
    author: { id: r.author_id, name: (r.name ?? "Former member") + (r.author_type === "agent" ? " (via agent)" : ""), image: r.image },
  }));
}

/** Idempotent on `id` so a retried create never duplicates the comment. */
export async function addComment(env: Env, actor: Actor, pageId: string, raw: unknown): Promise<CommentInfo> {
  const access = await requirePageAccess(env, actor, pageId, "write");
  if (access.page.state !== "active") throw new AppError("conflict", "Page is in the trash");
  const input = CreateCommentInput.parse(raw);
  const id = input.id ?? newId("cm");
  const t = Date.now();
  const res = await env.DB.prepare(
    "INSERT INTO comments (id, workspace_id, page_id, author_id, author_type, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, access.workspaceId, pageId, actor.userId, actor.kind, input.body, t)
    .run();
  const row = await env.DB.prepare("SELECT page_id, author_id FROM comments WHERE id = ?").bind(id).first<{ page_id: string; author_id: string }>();
  if (!row || row.page_id !== pageId || row.author_id !== actor.userId) throw new AppError("conflict", "Comment id already used");
  if (res.meta.changes) {
    await audit(env, access, "comment.create", id, { by: actorId(actor) });
    await publish(env, access.workspaceId, [["comments", pageId]]);
  }
  const list = await listComments(env, actor, pageId, null, 100);
  return list.find((c) => c.id === id) ?? { id, pageId, body: input.body, createdAt: t, author: { id: actor.userId, name: "", image: null } };
}

export async function deleteComment(env: Env, actor: Actor, pageId: string, commentId: string): Promise<void> {
  const access = await requirePageAccess(env, actor, pageId, "write");
  const row = await env.DB.prepare("SELECT author_id FROM comments WHERE id = ? AND page_id = ? AND deleted_at IS NULL").bind(commentId, pageId).first<{ author_id: string }>();
  if (!row) throw notFound("Comment");
  if (row.author_id !== actor.userId && access.role !== "owner") throw new AppError("forbidden", "Only the author or an owner can delete a comment");
  await env.DB.prepare("UPDATE comments SET deleted_at = ? WHERE id = ?").bind(Date.now(), commentId).run();
  await publish(env, access.workspaceId, [["comments", pageId]]);
}
