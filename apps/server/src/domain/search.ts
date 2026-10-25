import type { SearchHit } from "@workspace/core";
import { pageUrl } from "../util";
import { type Actor, requireAccess } from "./access";

/** Workspace-scoped full-text search. Membership is checked first; results never cross workspaces or include trash. */
export async function search(env: Env, actor: Actor, workspaceId: string, query: string, limit = 20): Promise<SearchHit[]> {
  await requireAccess(env, actor, workspaceId, "read");
  const terms = query
    .normalize("NFKC")
    .split(/\s+/)
    .map((t) => t.replace(/["*^():{}[\]\\]/g, "").slice(0, 50))
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return [];
  // Each term is quoted (no FTS operators from user input); the last one is a prefix match.
  const match = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
  const rows = await env.DB.prepare(
    `SELECT s.page_id, s.title, snippet(search_fts, 1, '[', ']', '…', 12) AS snippet
     FROM search_fts JOIN search_docs s ON s.rowid = search_fts.rowid
     JOIN pages p ON p.id = s.page_id
     WHERE search_fts MATCH ? AND s.workspace_id = ? AND p.state = 'active'
     ORDER BY bm25(search_fts, 5.0, 1.0) LIMIT ?`,
  )
    .bind(match, workspaceId, Math.min(limit, 50))
    .all<{ page_id: string; title: string; snippet: string }>();
  return rows.results.map((r) => ({ pageId: r.page_id, title: r.title, snippet: r.snippet ?? "", url: pageUrl(env, r.page_id) }));
}
