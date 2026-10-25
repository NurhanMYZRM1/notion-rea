import { backupDocuments } from "./backup";
import { log } from "./util";

/** Daily: back up changed page bodies to R2, then expire stale doc-session rows and old audit data. */
export async function runScheduled(env: Env): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  let total = 0;
  for (let i = 0; i < 25; i++) {
    const run = await backupDocuments(env);
    total += run.backedUp;
    if (!run.more) break;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM doc_sessions WHERE connected_at < ?").bind(Date.now() - 2 * day),
    env.DB.prepare("DELETE FROM audit_events WHERE created_at < ?").bind(Date.now() - 365 * day),
  ]);
  log("scheduled_cleanup", { backedUp: total });
}
