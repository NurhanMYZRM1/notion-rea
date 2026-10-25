import { page } from "./domain/pages";
import { log } from "./util";

const key = (workspaceId: string, pageId: string) => `backups/docs/${workspaceId}/${pageId}.yjs`;

/**
 * Copy changed page bodies (canonical Yjs state from each page Durable Object) to R2. Bounded per run;
 * the next run continues. Only pages edited since their last backup are read.
 */
export async function backupDocuments(env: Env, limit = 200): Promise<{ backedUp: number; skipped: number; more: boolean }> {
  const rows = await env.DB.prepare(
    // Only pages with a body (projected revision > 0): empty records never wake their object.
    `SELECT p.id, p.workspace_id FROM pages p
       JOIN search_docs s ON s.page_id = p.id AND s.revision > 0
       LEFT JOIN doc_backups b ON b.page_id = p.id
     WHERE p.state != 'deleted' AND (b.backed_up_at IS NULL OR p.updated_at > b.backed_up_at)
     ORDER BY p.updated_at LIMIT ?`,
  )
    .bind(limit + 1)
    .all<{ id: string; workspace_id: string }>();
  let backedUp = 0;
  let skipped = 0;
  for (const row of rows.results.slice(0, limit)) {
    const { state, revision } = await page(env, row.id).exportState();
    const prior = await env.DB.prepare("SELECT revision FROM doc_backups WHERE page_id = ?").bind(row.id).first<{ revision: number }>();
    const t = Date.now();
    if (prior?.revision !== revision || revision === 0) {
      await env.FILES.put(key(row.workspace_id, row.id), state, { customMetadata: { pageId: row.id, workspaceId: row.workspace_id, revision: String(revision) } });
      backedUp++;
    } else skipped++;
    await env.DB.prepare(
      `INSERT INTO doc_backups (page_id, workspace_id, revision, r2_key, bytes, backed_up_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET revision = excluded.revision, r2_key = excluded.r2_key, bytes = excluded.bytes, backed_up_at = excluded.backed_up_at`,
    )
      .bind(row.id, row.workspace_id, revision, key(row.workspace_id, row.id), state.byteLength, t)
      .run();
  }
  // Tombstoned pages: drop their backups so deleted content does not linger.
  const gone = await env.DB.prepare(
    "SELECT b.page_id, b.r2_key FROM doc_backups b JOIN pages p ON p.id = b.page_id WHERE p.state = 'deleted' LIMIT 500",
  ).all<{ page_id: string; r2_key: string }>();
  if (gone.results.length) {
    await env.FILES.delete(gone.results.map((g) => g.r2_key));
    await env.DB.prepare("DELETE FROM doc_backups WHERE page_id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(gone.results.map((g) => g.page_id)))
      .run();
  }
  log("backup_documents", { backedUp, skipped, purged: gone.results.length });
  return { backedUp, skipped, more: rows.results.length > limit };
}

/**
 * Restore page bodies from R2 into page Durable Objects (into an isolated environment whose D1 was
 * restored from an export). Merging a Yjs state is idempotent, so re-running is safe.
 */
export async function restoreDocuments(env: Env, cursor: string | null, limit = 200): Promise<{ restored: number; missing: string[]; next: string | null }> {
  const rows = await env.DB.prepare(
    `SELECT b.page_id, b.workspace_id, b.r2_key, b.revision FROM doc_backups b JOIN pages p ON p.id = b.page_id
     WHERE p.state != 'deleted' AND (? IS NULL OR b.page_id > ?) ORDER BY b.page_id LIMIT ?`,
  )
    .bind(cursor, cursor, limit + 1)
    .all<{ page_id: string; workspace_id: string; r2_key: string; revision: number }>();
  const missing: string[] = [];
  let restored = 0;
  const batch = rows.results.slice(0, limit);
  for (const row of batch) {
    const object = await env.FILES.get(row.r2_key);
    if (!object) {
      missing.push(row.page_id);
      continue;
    }
    await page(env, row.page_id).restoreState(row.page_id, row.workspace_id, new Uint8Array(await object.arrayBuffer()));
    restored++;
  }
  return { restored, missing, next: rows.results.length > limit ? batch.at(-1)!.page_id : null };
}
