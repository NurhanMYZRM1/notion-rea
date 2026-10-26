import { log } from "../util";

/** Retry durable parent projections. A generation guard preserves mutations arriving during RPC. */
export async function processPageReferences(env: Env, options: { workspaceId?: string; parentIds?: (string | null)[]; limit?: number } = {}): Promise<void> {
  const ids = options.parentIds?.filter((id): id is string => !!id);
  if (ids && !ids.length) return;
  const jobs = await env.DB.prepare(`SELECT parent_id, workspace_id, version FROM page_reference_outbox
    WHERE (? IS NULL OR workspace_id = ?) AND (? IS NULL OR parent_id IN (SELECT value FROM json_each(?)))
    ORDER BY updated_at, parent_id LIMIT ?`)
    .bind(options.workspaceId ?? null, options.workspaceId ?? null, ids ? JSON.stringify(ids) : null, ids ? JSON.stringify(ids) : null, options.limit ?? 100)
    .all<{ parent_id: string; workspace_id: string; version: number }>();
  for (const job of jobs.results) {
    try {
      await env.PAGE.get(env.PAGE.idFromName(job.parent_id)).reconcileChildPages(job.parent_id, job.workspace_id);
      await env.DB.prepare("DELETE FROM page_reference_outbox WHERE parent_id = ? AND version = ?").bind(job.parent_id, job.version).run();
    } catch (err) {
      const error = String(err).slice(0, 300);
      await env.DB.prepare("UPDATE page_reference_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE parent_id = ? AND version = ?")
        .bind(error, Date.now(), job.parent_id, job.version).run();
      log("page_reference_retry", { parentId: job.parent_id, error });
    }
  }
}
