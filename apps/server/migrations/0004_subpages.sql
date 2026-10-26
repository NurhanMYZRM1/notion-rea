-- D1 relationships remain authoritative. Triggers enqueue the complete parent projection
-- atomically with every metadata mutation, including MCP, imports, and bulk archive/restore.
CREATE TABLE page_reference_outbox (
  parent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX page_reference_outbox_retry ON page_reference_outbox(updated_at, parent_id);
CREATE TABLE page_reference_anchors (
  child_id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  after_block_id TEXT NOT NULL
);
CREATE INDEX pages_hierarchy ON pages(workspace_id, parent_id, state, position, id);

CREATE TRIGGER pages_reference_insert AFTER INSERT ON pages
WHEN NEW.parent_id IS NOT NULL AND NEW.database_id IS NULL
BEGIN
  INSERT INTO page_reference_outbox(parent_id, workspace_id, updated_at)
  VALUES(NEW.parent_id, NEW.workspace_id, NEW.updated_at)
  ON CONFLICT(parent_id) DO UPDATE SET version = version + 1, attempts = 0, last_error = NULL, updated_at = excluded.updated_at;
END;
CREATE TRIGGER pages_reference_update AFTER UPDATE OF parent_id, state, title, icon ON pages
WHEN NEW.database_id IS NULL
BEGIN
  INSERT INTO page_reference_outbox(parent_id, workspace_id, updated_at)
  SELECT OLD.parent_id, OLD.workspace_id, NEW.updated_at WHERE OLD.parent_id IS NOT NULL
  ON CONFLICT(parent_id) DO UPDATE SET version = version + 1, attempts = 0, last_error = NULL, updated_at = excluded.updated_at;
  INSERT INTO page_reference_outbox(parent_id, workspace_id, updated_at)
  SELECT NEW.parent_id, NEW.workspace_id, NEW.updated_at WHERE NEW.parent_id IS NOT NULL
  ON CONFLICT(parent_id) DO UPDATE SET version = version + 1, attempts = 0, last_error = NULL, updated_at = excluded.updated_at;
END;

-- Existing content is untouched; missing owning blocks are appended on the next read/retry.
INSERT INTO page_reference_outbox(parent_id, workspace_id, updated_at)
SELECT DISTINCT parent_id, workspace_id, 0 FROM pages
WHERE parent_id IS NOT NULL AND database_id IS NULL AND state != 'deleted';
