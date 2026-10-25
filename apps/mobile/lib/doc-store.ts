import type { DocStore } from "@workspace/core/sync";
import * as Y from "yjs";

/**
 * Per-account SQLite storage: Yjs update log per page, doc metadata, and a small JSON key-value cache
 * for workspace metadata (tree, favorites, recents, page detail) so the shell works offline.
 * Takes the subset of expo-sqlite's `SQLiteDatabase` it needs, so tests can pass a node:sqlite fake.
 */
export type SqlValue = string | number | null | boolean | Uint8Array;
export interface Sql {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SqlValue[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export const LIMITS = { docs: 20, bytes: 50 * 1024 * 1024, mergeAbove: 100 };

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS docs (
  page_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  local_counter INTEGER NOT NULL DEFAULT 0,
  synced_counter INTEGER NOT NULL DEFAULT 0,
  revision INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  last_opened INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  data BLOB NOT NULL,
  counter INTEGER
);
CREATE INDEX IF NOT EXISTS updates_page ON updates(page_id, id);
-- One INSERT is atomic with its trigger, so the pending-edit counter can never lag the stored update.
CREATE TRIGGER IF NOT EXISTS updates_meta AFTER INSERT ON updates BEGIN
  UPDATE docs SET bytes = bytes + length(NEW.data), local_counter = MAX(local_counter, COALESCE(NEW.counter, 0))
  WHERE page_id = NEW.page_id;
END;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export async function migrate(sql: Sql): Promise<void> {
  await sql.execAsync(SCHEMA);
}

/** Register (or touch) a doc before its provider starts, so appends always have a meta row. */
export async function openDoc(sql: Sql, pageId: string, workspaceId: string, title: string, now = Date.now()): Promise<{ cached: boolean }> {
  await sql.runAsync(
    `INSERT INTO docs (page_id, workspace_id, title, last_opened) VALUES (?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET last_opened = excluded.last_opened, title = CASE WHEN excluded.title = '' THEN docs.title ELSE excluded.title END`,
    [pageId, workspaceId, title, now],
  );
  const row = await sql.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM updates WHERE page_id = ?", [pageId]);
  return { cached: (row?.n ?? 0) > 0 };
}

export function docStore(sql: Sql, pageId: string): DocStore {
  return {
    async load() {
      const meta = await sql.getFirstAsync<{ local_counter: number; synced_counter: number }>(
        "SELECT local_counter, synced_counter FROM docs WHERE page_id = ?",
        [pageId],
      );
      const rows = await sql.getAllAsync<{ id: number; data: Uint8Array }>("SELECT id, data FROM updates WHERE page_id = ? ORDER BY id", [pageId]);
      let updates = rows.map((r) => r.data);
      if (rows.length > LIMITS.mergeAbove) {
        const merged = Y.mergeUpdates(updates);
        const lastId = rows[rows.length - 1]!.id;
        await sql.withTransactionAsync(async () => {
          await sql.runAsync("DELETE FROM updates WHERE page_id = ? AND id <= ?", [pageId, lastId]);
          await sql.runAsync("INSERT INTO updates (page_id, data, counter) VALUES (?, ?, NULL)", [pageId, merged]);
          await sql.runAsync("UPDATE docs SET bytes = (SELECT COALESCE(SUM(length(data)), 0) FROM updates WHERE page_id = ?) WHERE page_id = ?", [pageId, pageId]);
        });
        updates = [merged];
      }
      return { updates, localCounter: meta?.local_counter ?? 0, syncedCounter: meta?.synced_counter ?? 0 };
    },
    // Resolves only after SQLite committed the row (WAL, synchronous=FULL): "Saved on device" is never early.
    async append(update, localCounter) {
      await sql.runAsync("INSERT INTO updates (page_id, data, counter) VALUES (?, ?, ?)", [pageId, update, localCounter]);
    },
    async markSynced(counter, revision) {
      await sql.runAsync("UPDATE docs SET synced_counter = MAX(synced_counter, ?), revision = ? WHERE page_id = ?", [counter, revision, pageId]);
    },
  };
}

/** LRU eviction to `LIMITS`; never evicts docs with unsynced local edits or `keep`. Returns evicted ids. */
export async function evict(sql: Sql, keep: string | null, limits = LIMITS): Promise<string[]> {
  const rows = await sql.getAllAsync<{ page_id: string; bytes: number; dirty: number }>(
    "SELECT page_id, bytes, local_counter > synced_counter AS dirty FROM docs ORDER BY last_opened DESC",
    [],
  );
  const pinned = (r: (typeof rows)[number]) => !!r.dirty || r.page_id === keep;
  // Pinned docs take budget first; the rest fill what is left, newest first.
  let count = 0;
  let bytes = 0;
  for (const r of rows.filter(pinned)) {
    count++;
    bytes += r.bytes;
  }
  const victims: string[] = [];
  for (const r of rows) {
    if (pinned(r)) continue;
    if (count + 1 > limits.docs || bytes + r.bytes > limits.bytes) victims.push(r.page_id);
    else {
      count++;
      bytes += r.bytes;
    }
  }
  if (victims.length) await dropDocs(sql, victims);
  return victims;
}

async function dropDocs(sql: Sql, ids: string[]) {
  await sql.withTransactionAsync(async () => {
    for (const id of ids) {
      await sql.runAsync("DELETE FROM updates WHERE page_id = ?", [id]);
      await sql.runAsync("DELETE FROM docs WHERE page_id = ?", [id]);
    }
  });
}

export interface Draft {
  pageId: string;
  workspaceId: string;
  title: string;
}

/** Docs whose local edits the server has not acknowledged. */
export async function pendingDrafts(sql: Sql): Promise<Draft[]> {
  return sql.getAllAsync<Draft>(
    "SELECT page_id AS pageId, workspace_id AS workspaceId, title FROM docs WHERE local_counter > synced_counter ORDER BY last_opened DESC",
    [],
  );
}

export async function cacheStatus(sql: Sql): Promise<{ docs: number; bytes: number; drafts: number; entries: number }> {
  const d = await sql.getFirstAsync<{ docs: number; bytes: number; drafts: number }>(
    "SELECT COUNT(*) AS docs, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(local_counter > synced_counter), 0) AS drafts FROM docs",
    [],
  );
  const k = await sql.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM kv", []);
  return { docs: d?.docs ?? 0, bytes: d?.bytes ?? 0, drafts: d?.drafts ?? 0, entries: k?.n ?? 0 };
}

/** Clear cached docs and metadata, keeping docs with unsynced edits. */
export async function clearCache(sql: Sql, keep: string | null = null): Promise<void> {
  const rows = await sql.getAllAsync<{ page_id: string }>("SELECT page_id FROM docs WHERE local_counter <= synced_counter", []);
  await dropDocs(
    sql,
    rows.map((r) => r.page_id).filter((id) => id !== keep),
  );
  await sql.runAsync("DELETE FROM kv WHERE key NOT LIKE 'pref:%'", []);
}

/** Load a stored doc into a fresh Y.Doc (for exporting a draft that is not open). */
export async function loadDoc(sql: Sql, pageId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const { updates } = await docStore(sql, pageId).load();
  Y.transact(doc, () => updates.forEach((u) => Y.applyUpdate(doc, u)));
  return doc;
}

export async function kvGet<T>(sql: Sql, key: string): Promise<T | undefined> {
  const row = await sql.getFirstAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export async function kvSet(sql: Sql, key: string, value: unknown): Promise<void> {
  await sql.runAsync("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [
    key,
    JSON.stringify(value),
    Date.now(),
  ]);
}
