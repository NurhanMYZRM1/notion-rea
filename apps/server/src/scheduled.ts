import { log } from "./util";

/** Daily housekeeping: expire stale doc-session rows and old audit/idempotency data. */
export async function runScheduled(env: Env): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM doc_sessions WHERE connected_at < ?").bind(Date.now() - 2 * day),
    env.DB.prepare("DELETE FROM audit_events WHERE created_at < ?").bind(Date.now() - 365 * day),
  ]);
  log("scheduled_cleanup");
}
