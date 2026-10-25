import { done, openDb, req } from "../idb";
import { docDbName } from "../persist";

/**
 * Per-account document cache (`ws-cache-<userId>`), keyed by `<workspaceId>:<pageId>` so caches are
 * isolated by account (database) and workspace (key). yjs-free so Settings can read stats cheaply.
 */
export interface DocMeta {
  key: string;
  workspaceId: string;
  pageId: string;
  title: string;
  localCounter: number;
  syncedCounter: number;
  revision: number | null;
  bytes: number;
  count: number;
  lastOpened: number;
}
export interface StoredUpdate {
  doc: string;
  data: Uint8Array;
}

export const MAX_DOCS = 20;
export const MAX_BYTES = 50 * 1024 * 1024;

export const docKey = (workspaceId: string, pageId: string) => `${workspaceId}:${pageId}`;
export const hasPending = (m: DocMeta) => m.localCounter > m.syncedCounter;

let account: { userId: string; db: Promise<IDBDatabase> } | null = null;
/** Docs currently open in this tab: never evicted or cleared underneath the editor. */
export const openKeys = new Set<string>();

export function setDocAccount(userId: string) {
  if (account?.userId === userId) return;
  void closeDocDb();
  account = {
    userId,
    db: openDb(docDbName(userId), 1, (db) => {
      db.createObjectStore("docs", { keyPath: "key" });
      db.createObjectStore("updates", { autoIncrement: true }).createIndex("doc", "doc");
    }),
  };
}

export function docDb(): Promise<IDBDatabase> {
  if (!account) return Promise.reject(new Error("No signed-in account"));
  return account.db;
}

export async function closeDocDb() {
  const a = account;
  account = null;
  if (a) (await a.db.catch(() => null))?.close();
}

export async function listDocs(): Promise<DocMeta[]> {
  const db = await docDb();
  return req<DocMeta[]>(db.transaction("docs").objectStore("docs").getAll());
}

/** Delete docs (and their updates) inside an open readwrite transaction. */
export function deleteDocsIn(tx: IDBTransaction, keys: string[]) {
  const docs = tx.objectStore("docs");
  const index = tx.objectStore("updates").index("doc");
  for (const key of keys) {
    docs.delete(key);
    const cur = index.openKeyCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      tx.objectStore("updates").delete(c.primaryKey);
      c.continue();
    };
  }
}

/** Clear cached documents. Docs with unsynced edits are kept unless `includePending`. Returns how many were removed. */
export async function clearDocs(includePending: boolean): Promise<number> {
  const db = await docDb();
  const metas = await listDocs();
  const keys = metas.filter((m) => !openKeys.has(m.key) && (includePending || !hasPending(m))).map((m) => m.key);
  const tx = db.transaction(["docs", "updates"], "readwrite");
  const d = done(tx);
  deleteDocsIn(tx, keys);
  await d;
  return keys.length;
}
