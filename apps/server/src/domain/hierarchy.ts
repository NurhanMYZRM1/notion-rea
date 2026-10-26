import type { HierarchyNode, HierarchyResult } from "@workspace/core";
import { AppError, notFound } from "../errors";
import { type Actor, requireAccess, requirePageAccess } from "./access";
import { type PageRow, toSummary } from "./pages";

const COLUMNS = `p.id, p.workspace_id, p.parent_id, p.database_id, p.is_database, p.title, p.icon, p.position, p.state, p.revision, p.updated_at,
  EXISTS(SELECT 1 FROM pages c WHERE c.workspace_id = p.workspace_id AND c.parent_id = p.id AND c.state = 'active') AS has_children`;
const node = (env: Env, row: PageRow): HierarchyNode => ({ ...toSummary(env, row), kind: row.is_database ? "database" : row.database_id ? "record" : "page" });

/** Metadata only: pagination is stable even if concurrent siblings have the same position. */
export async function hierarchy(env: Env, actor: Actor, workspaceId: string, options: {
  parentId?: string | null; cursor?: string | null; limit?: number; focusId?: string | null;
}): Promise<HierarchyResult> {
  await requireAccess(env, actor, workspaceId, "read");
  const parentId = options.parentId ?? null;
  for (const id of new Set([parentId, options.focusId].filter((v): v is string => !!v))) {
    const access = await requirePageAccess(env, actor, id, "read");
    if (access.workspaceId !== workspaceId || access.page.state !== "active") throw notFound();
  }
  let cursor: [string, string] | null = null;
  if (options.cursor) {
    try {
      const parsed = JSON.parse(atob(options.cursor));
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((v) => typeof v !== "string")) throw new Error();
      cursor = parsed as [string, string];
    } catch { throw new AppError("invalid_input", "Invalid hierarchy cursor"); }
  }
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100) || 100));
  const rows = await env.DB.prepare(`SELECT ${COLUMNS} FROM pages p
    WHERE p.workspace_id = ? AND p.parent_id IS ? AND p.state = 'active'
      AND (? IS NULL OR p.position > ? OR (p.position = ? AND p.id > ?))
    ORDER BY p.position, p.id LIMIT ?`)
    .bind(workspaceId, parentId, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1).all<PageRow>();
  const list = rows.results.slice(0, limit);
  const path: HierarchyNode[] = [];
  if (options.focusId) {
    const ancestors = (await env.DB.prepare(`WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM pages WHERE id = ? AND workspace_id = ? AND state = 'active'
      UNION SELECT p.id, p.parent_id FROM pages p JOIN ancestors a ON p.id = a.parent_id
        WHERE p.workspace_id = ? AND p.state = 'active'
      ) SELECT ${COLUMNS} FROM ancestors a JOIN pages p ON p.id = a.id`)
      .bind(options.focusId, workspaceId, workspaceId).all<PageRow>()).results;
    const byId = new Map(ancestors.map((row) => [row.id, row]));
    let id: string | null = options.focusId;
    while (id && byId.has(id)) {
      const row: PageRow = byId.get(id)!;
      path.push(node(env, row));
      byId.delete(id);
      id = row.parent_id;
    }
    path.reverse();
  }
  const last = list.at(-1);
  return { nodes: list.map((r) => node(env, r)), nextCursor: rows.results.length > limit && last ? btoa(JSON.stringify([last.position, last.id])) : null, path };
}
