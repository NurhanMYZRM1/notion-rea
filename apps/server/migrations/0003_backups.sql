-- Latest durable backup of each page body (Yjs state) in R2. Metadata itself is backed up by
-- D1 Time Travel plus `wrangler d1 export` (see docs/OPERATIONS.md).
CREATE TABLE doc_backups (
  page_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  backed_up_at INTEGER NOT NULL
);
