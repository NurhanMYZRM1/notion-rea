import { CreatePageInput, MovePageInput, newId, type PageDetail, type PageSummary, type PMNode, UpdatePageInput } from "@workspace/core";
import { generateKeyBetween } from "fractional-indexing";
import type { z } from "zod";
import { AppError, conflict, notFound } from "../errors";
import { pageUrl } from "../util";
import { type Access, type Actor, audit, requireAccess, requirePageAccess } from "./access";

export interface PageRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  database_id: string | null;
  is_database: number;
  title: string;
  icon: string | null;
  position: string;
  state: "active" | "archived" | "deleted";
  archived_at: number | null;
  archive_root: string | null;
  props: string;
  revision: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  has_children?: number;
}

const SUMMARY_COLUMNS = `p.id, p.workspace_id, p.parent_id, p.database_id, p.is_database, p.title, p.icon, p.position, p.state,
  p.archived_at, p.archive_root, p.props, p.revision, p.created_by, p.created_at, p.updated_at,
  EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.state = 'active' AND c.database_id IS NULL) AS has_children`;

export function toSummary(env: Env, row: PageRow): PageSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    databaseId: row.database_id,
    isDatabase: !!row.is_database,
    title: row.title,
    icon: row.icon,
    position: row.position,
    state: row.state,
    hasChildren: !!row.has_children,
    revision: row.revision,
    updatedAt: row.updated_at,
    url: pageUrl(env, row.id),
  };
}

export function page(env: Env, id: string) {
  return env.PAGE.get(env.PAGE.idFromName(id));
}

export async function publish(env: Env, workspaceId: string, invalidate: (string | null)[][], ctx?: ExecutionContext): Promise<void> {
  const send = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
    .publish({ invalidate, at: Date.now() })
    .catch(() => {});
  if (ctx) ctx.waitUntil(send);
  else await send;
}

async function getRow(env: Env, id: string): Promise<PageRow | null> {
  return env.DB.prepare(`SELECT ${SUMMARY_COLUMNS} FROM pages p WHERE p.id = ?`).bind(id).first<PageRow>();
}

/** Sidebar children of a parent (null = workspace root). Bounded and cursor-paginated by position. */
export async function listChildren(
  env: Env,
  actor: Actor,
  workspaceId: string,
  parentId: string | null,
  cursor: string | null,
  limit = 100,
): Promise<{ pages: PageSummary[]; nextCursor: string | null }> {
  await requireAccess(env, actor, workspaceId, "read");
  if (parentId) await requirePageAccess(env, actor, parentId, "read");
  const rows = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM pages p
     WHERE p.workspace_id = ? AND p.parent_id IS ? AND p.state = 'active' AND p.database_id IS NULL
       AND (? IS NULL OR p.position > ?)
     ORDER BY p.position LIMIT ?`,
  )
    .bind(workspaceId, parentId, cursor, cursor, limit + 1)
    .all<PageRow>();
  const list = rows.results.slice(0, limit);
  return { pages: list.map((r) => toSummary(env, r)), nextCursor: rows.results.length > limit ? list.at(-1)!.position : null };
}

export async function getPage(env: Env, actor: Actor, pageId: string): Promise<PageDetail> {
  const access = await requirePageAccess(env, actor, pageId, "read");
  const row = (await getRow(env, pageId))!;
  const crumbs = await env.DB.prepare(
    `WITH RECURSIVE chain(id, parent_id, title, depth) AS (
       SELECT id, parent_id, title, 0 FROM pages WHERE id = ?
       UNION ALL SELECT p.id, p.parent_id, p.title, c.depth + 1 FROM pages p JOIN chain c ON p.id = c.parent_id WHERE c.depth < 50
     ) SELECT id, title FROM chain WHERE id != ? ORDER BY depth DESC`,
  )
    .bind(pageId, pageId)
    .all<{ id: string; title: string }>();
  const fav = await env.DB.prepare("SELECT 1 AS x FROM favorites WHERE user_id = ? AND page_id = ?")
    .bind(access.actor.userId, pageId)
    .first();
  return {
    ...toSummary(env, row),
    props: JSON.parse(row.props),
    breadcrumbs: crumbs.results,
    createdAt: row.created_at,
    createdBy: row.created_by ?? "",
    archivedAt: row.archived_at,
    favorite: !!fav,
  };
}

async function positionAfter(env: Env, workspaceId: string, parentId: string | null, afterId: string | null | undefined): Promise<string> {
  if (afterId) {
    const after = await env.DB.prepare("SELECT position FROM pages WHERE id = ? AND workspace_id = ? AND parent_id IS ?")
      .bind(afterId, workspaceId, parentId)
      .first<{ position: string }>();
    if (!after) throw new AppError("invalid_input", "afterId is not a sibling under this parent");
    const next = await env.DB.prepare(
      "SELECT position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND position > ? ORDER BY position LIMIT 1",
    )
      .bind(workspaceId, parentId, after.position)
      .first<{ position: string }>();
    return generateKeyBetween(after.position, next?.position ?? null);
  }
  const last = await env.DB.prepare("SELECT MAX(position) AS position FROM pages WHERE workspace_id = ? AND parent_id IS ?")
    .bind(workspaceId, parentId)
    .first<{ position: string | null }>();
  return generateKeyBetween(last?.position ?? null, null);
}

/**
 * Create a page. Idempotent on `input.id`: a retry returns the existing page. Optional initial body
 * is written to the page object afterwards; that write is itself idempotent, so a retry after a
 * partial failure completes it.
 */
export async function createPage(
  env: Env,
  actor: Actor,
  workspaceId: string,
  raw: z.input<typeof CreatePageInput>,
  body?: PMNode,
  extra: { databaseId?: string; isDatabase?: boolean; props?: Record<string, unknown> } = {},
): Promise<PageSummary> {
  const access = await requireAccess(env, actor, workspaceId, "write");
  const input = CreatePageInput.parse(raw);
  if (input.parentId) {
    const parent = await requirePageAccess(env, actor, input.parentId, "write");
    if (parent.page.workspace_id !== workspaceId || parent.page.state !== "active") throw new AppError("invalid_input", "Parent page is not available");
  }
  const id = input.id ?? newId("pg");
  const existing = await getRow(env, id);
  if (existing) {
    if (existing.workspace_id !== workspaceId) throw conflict("Id already in use");
  } else {
    const t = Date.now();
    const position = await positionAfter(env, workspaceId, input.parentId, input.afterId);
    await env.DB.prepare(
      `INSERT INTO pages (id, workspace_id, parent_id, database_id, is_database, title, icon, position, props, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
      .bind(id, workspaceId, input.parentId, extra.databaseId ?? null, extra.isDatabase ? 1 : 0, input.title, input.icon ?? null, position, JSON.stringify(extra.props ?? {}), actor.userId, t, actor.userId, t)
      .run();
    await env.DB.prepare(
      "INSERT INTO search_docs (page_id, workspace_id, title) VALUES (?, ?, ?) ON CONFLICT(page_id) DO UPDATE SET title = excluded.title",
    )
      .bind(id, workspaceId, input.title)
      .run();
    await audit(env, access, "page.create", id);
  }
  if (body) await page(env, id).initialize(id, workspaceId, body);
  await publish(env, workspaceId, [["pages", input.parentId], ["recents"]]);
  return toSummary(env, (await getRow(env, id))!);
}

export async function updatePage(env: Env, actor: Actor, pageId: string, raw: unknown): Promise<PageSummary> {
  const access = await requirePageAccess(env, actor, pageId, "write");
  if (access.page.state !== "active") throw conflict("Page is in the trash; restore it first");
  const input = UpdatePageInput.parse(raw);
  const result = await env.DB.prepare(
    `UPDATE pages SET title = COALESCE(?, title), icon = CASE WHEN ? THEN ? ELSE icon END,
       revision = revision + 1, updated_at = ?, updated_by = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(input.title ?? null, input.icon !== undefined ? 1 : 0, input.icon ?? null, Date.now(), actor.userId, pageId, input.expectedRevision)
    .run();
  const row = (await getRow(env, pageId))!;
  if (!result.meta.changes) throw conflict("Page was changed by someone else", toSummary(env, row));
  if (input.title !== undefined) {
    await env.DB.prepare("UPDATE search_docs SET title = ? WHERE page_id = ?").bind(row.title, pageId).run();
  }
  await publish(env, access.workspaceId, [["page", pageId], ["pages", row.parent_id], ...(row.database_id ? [["database", row.database_id]] : [])]);
  return toSummary(env, row);
}

export async function movePage(env: Env, actor: Actor, pageId: string, raw: unknown): Promise<PageSummary> {
  const access = await requirePageAccess(env, actor, pageId, "write");
  const input = MovePageInput.parse(raw);
  const before = (await getRow(env, pageId))!;
  if (before.database_id) throw new AppError("unsupported", "Database records move with their database");
  if (input.parentId) {
    const target = await requirePageAccess(env, actor, input.parentId, "write");
    if (target.page.workspace_id !== access.workspaceId || target.page.state !== "active") throw new AppError("invalid_input", "Target is not available");
    // Reject cycles: the target may not be this page or one of its descendants.
    const cycle = await env.DB.prepare(
      `WITH RECURSIVE up(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM pages WHERE id = ?
         UNION ALL SELECT p.id, p.parent_id, u.depth + 1 FROM pages p JOIN up u ON p.id = u.parent_id WHERE u.depth < 200
       ) SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`,
    )
      .bind(input.parentId, pageId)
      .first();
    if (cycle) throw new AppError("invalid_input", "Cannot move a page inside itself");
  }
  const position = await positionAfter(env, access.workspaceId, input.parentId, input.afterId);
  const result = await env.DB.prepare(
    "UPDATE pages SET parent_id = ?, position = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ? AND revision = ?",
  )
    .bind(input.parentId, position, Date.now(), actor.userId, pageId, input.expectedRevision)
    .run();
  const row = (await getRow(env, pageId))!;
  if (!result.meta.changes) throw conflict("Page was changed by someone else", toSummary(env, row));
  await publish(env, access.workspaceId, [["pages", before.parent_id], ["pages", input.parentId], ["page", pageId]]);
  return toSummary(env, row);
}

const SUBTREE = `WITH RECURSIVE sub(id, depth) AS (
  SELECT id, 0 FROM pages WHERE id = ?
  UNION ALL SELECT p.id, s.depth + 1 FROM pages p JOIN sub s ON p.parent_id = s.id WHERE p.state = ? AND s.depth < 200
)`;

async function notifyOpenDocs(env: Env, pageIds: string[], fn: (stub: ReturnType<typeof page>, id: string) => Promise<unknown>) {
  if (!pageIds.length) return;
  const open = await env.DB.prepare(
    `SELECT DISTINCT page_id FROM doc_sessions WHERE page_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(pageIds))
    .all<{ page_id: string }>();
  await Promise.allSettled(open.results.map((r) => fn(page(env, r.page_id), r.page_id)));
}

/** Move a page and its active descendants to the trash. Idempotent. */
export async function archivePage(env: Env, actor: Actor, pageId: string): Promise<PageSummary> {
  const access = await requirePageAccess(env, actor, pageId, "archive");
  const row = (await getRow(env, pageId))!;
  if (row.state === "archived") return toSummary(env, row);
  const t = Date.now();
  const affected = await env.DB.prepare(
    `${SUBTREE} UPDATE pages SET state = 'archived', archived_at = ?, archived_by = ?, archive_root = ?, revision = revision + 1, updated_at = ?
     WHERE id IN (SELECT id FROM sub) AND state = 'active' RETURNING id`,
  )
    .bind(pageId, "active", t, actor.userId, pageId, t)
    .all<{ id: string }>();
  await audit(env, access, "page.archive", pageId, { count: affected.results.length });
  await notifyOpenDocs(env, affected.results.map((r) => r.id), (stub, id) => stub.setState(id, "archived"));
  await publish(env, access.workspaceId, [["pages", row.parent_id], ["page", pageId], ["trash"], ...(row.database_id ? [["database", row.database_id]] : [])]);
  return toSummary(env, (await getRow(env, pageId))!);
}

/** Restore a trashed page (and what was trashed with it). If its parent is gone, it moves to the top level. */
export async function restorePage(env: Env, actor: Actor, pageId: string): Promise<PageSummary> {
  const access = await requirePageAccess(env, actor, pageId, "archive");
  const row = (await getRow(env, pageId))!;
  if (row.state === "active") return toSummary(env, row);
  const root = row.archive_root ?? pageId;
  if (root !== pageId) throw new AppError("invalid_input", "Restore the page that was moved to the trash", { archiveRoot: root });
  let parentId = row.parent_id;
  if (parentId) {
    const parent = await env.DB.prepare("SELECT state FROM pages WHERE id = ?").bind(parentId).first<{ state: string }>();
    if (!parent || parent.state !== "active") parentId = row.database_id ?? null;
  }
  const restored = await env.DB.prepare(
    `UPDATE pages SET state = 'active', archived_at = NULL, archived_by = NULL, archive_root = NULL,
       parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END, revision = revision + 1, updated_at = ?
     WHERE workspace_id = ? AND archive_root = ? AND state = 'archived' RETURNING id`,
  )
    .bind(pageId, parentId, Date.now(), access.workspaceId, root)
    .all<{ id: string }>();
  await audit(env, access, "page.restore", pageId, { count: restored.results.length });
  await notifyOpenDocs(env, restored.results.map((r) => r.id), (stub, id) => stub.setState(id, "active"));
  await publish(env, access.workspaceId, [["pages", parentId], ["page", pageId], ["trash"], ...(row.database_id ? [["database", row.database_id]] : [])]);
  return toSummary(env, (await getRow(env, pageId))!);
}

/** Permanently delete a trashed page tree (owners). Leaves tombstones so nothing can resurrect it. */
export async function deletePermanently(env: Env, actor: Actor, pageId: string): Promise<{ deleted: number }> {
  const access = await requirePageAccess(env, actor, pageId, "delete_permanently");
  const row = (await getRow(env, pageId))!;
  if (row.state !== "archived" || (row.archive_root ?? pageId) !== pageId) throw new AppError("invalid_input", "Only pages moved to the trash can be deleted");
  const ids = (
    await env.DB.prepare("SELECT id FROM pages WHERE workspace_id = ? AND archive_root = ?").bind(access.workspaceId, pageId).all<{ id: string }>()
  ).results.map((r) => r.id);
  const list = JSON.stringify(ids);
  const files = await env.DB.prepare("SELECT r2_key FROM attachments WHERE page_id IN (SELECT value FROM json_each(?))").bind(list).all<{ r2_key: string }>();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pages SET state = 'deleted', title = '', icon = NULL, props = '{}', revision = revision + 1, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))",
    ).bind(Date.now(), list),
    env.DB.prepare("DELETE FROM search_docs WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
    env.DB.prepare("DELETE FROM comments WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
    env.DB.prepare("DELETE FROM attachments WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
    env.DB.prepare("DELETE FROM favorites WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
    env.DB.prepare("DELETE FROM recents WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
    env.DB.prepare("DELETE FROM databases WHERE page_id IN (SELECT value FROM json_each(?))").bind(list),
  ]);
  for (let i = 0; i < files.results.length; i += 1000) await env.FILES.delete(files.results.slice(i, i + 1000).map((f) => f.r2_key));
  await Promise.allSettled(ids.map((id) => page(env, id).purge()));
  await audit(env, access, "page.delete", pageId, { count: ids.length });
  await publish(env, access.workspaceId, [["trash"], ["page", pageId]]);
  return { deleted: ids.length };
}

export async function listTrash(env: Env, actor: Actor, workspaceId: string): Promise<PageSummary[]> {
  await requireAccess(env, actor, workspaceId, "read");
  const rows = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM pages p WHERE p.workspace_id = ? AND p.state = 'archived' AND p.archive_root = p.id
     ORDER BY p.archived_at DESC LIMIT 200`,
  )
    .bind(workspaceId)
    .all<PageRow>();
  return rows.results.map((r) => toSummary(env, r));
}

export async function setFavorite(env: Env, actor: Actor, pageId: string, favorite: boolean): Promise<void> {
  const access = await requirePageAccess(env, actor, pageId, "read");
  if (favorite) {
    await env.DB.prepare("INSERT OR IGNORE INTO favorites (user_id, workspace_id, page_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(actor.userId, access.workspaceId, pageId, Date.now())
      .run();
  } else {
    await env.DB.prepare("DELETE FROM favorites WHERE user_id = ? AND page_id = ?").bind(actor.userId, pageId).run();
  }
}

export async function recordVisit(env: Env, actor: Actor, pageId: string): Promise<void> {
  const access = await requirePageAccess(env, actor, pageId, "read");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO recents (user_id, workspace_id, page_id, visited_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, page_id) DO UPDATE SET visited_at = excluded.visited_at",
    ).bind(actor.userId, access.workspaceId, pageId, Date.now()),
    // Bound per-user recents.
    env.DB.prepare(
      `DELETE FROM recents WHERE user_id = ? AND workspace_id = ? AND page_id NOT IN
         (SELECT page_id FROM recents WHERE user_id = ? AND workspace_id = ? ORDER BY visited_at DESC LIMIT 50)`,
    ).bind(actor.userId, access.workspaceId, actor.userId, access.workspaceId),
  ]);
}

export async function listPinned(env: Env, actor: Actor, workspaceId: string, which: "favorites" | "recents"): Promise<PageSummary[]> {
  await requireAccess(env, actor, workspaceId, "read");
  const order = which === "favorites" ? "f.created_at" : "f.visited_at DESC";
  const rows = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM ${which} f JOIN pages p ON p.id = f.page_id
     WHERE f.user_id = ? AND f.workspace_id = ? AND p.state = 'active' ORDER BY ${order} LIMIT 50`,
  )
    .bind(actor.userId, workspaceId)
    .all<PageRow>();
  return rows.results.map((r) => toSummary(env, r));
}

export async function ensureActivePage(env: Env, access: Access, pageId: string): Promise<PageRow> {
  const row = await getRow(env, pageId);
  if (!row || row.workspace_id !== access.workspaceId || row.state === "deleted") throw notFound();
  return row;
}
