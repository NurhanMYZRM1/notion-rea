import { FRAGMENT, toMarkdown, yToJSON } from "@workspace/core";
import type { DocStore } from "@workspace/core/sync";
import * as Y from "yjs";
import { done, req } from "../idb";
import { type DocMeta, deleteDocsIn, docDb, docKey, hasPending, listDocs, MAX_BYTES, MAX_DOCS, openKeys, type StoredUpdate } from "./cache-db";

const MERGE_THRESHOLD = 100;

/**
 * IndexedDB DocStore. `append` resolves only on the transaction's `complete` event; local/synced
 * counters are persisted next to the updates so unsynced edits survive reloads and are never evicted.
 */
export class IdbDocStore implements DocStore {
  constructor(
    private db: IDBDatabase,
    readonly key: string,
    private info: { workspaceId: string; pageId: string; title: string },
  ) {}

  private fresh(): DocMeta {
    return { key: this.key, ...this.info, localCounter: 0, syncedCounter: 0, revision: null, bytes: 0, count: 0, lastOpened: Date.now() };
  }

  async load(): Promise<{ updates: Uint8Array[]; localCounter: number; syncedCounter: number }> {
    const tx = this.db.transaction(["docs", "updates"], "readwrite");
    const complete = done(tx);
    const docs = tx.objectStore("docs");
    const ups = tx.objectStore("updates");
    const meta = (await req<DocMeta | undefined>(docs.get(this.key))) ?? this.fresh();
    const index = ups.index("doc");
    const [entries, keys] = await Promise.all([req<StoredUpdate[]>(index.getAll(this.key)), req<IDBValidKey[]>(index.getAllKeys(this.key))]);
    let updates = entries.map((e) => e.data);
    if (updates.length > MERGE_THRESHOLD) {
      const merged = Y.mergeUpdates(updates);
      for (const k of keys) ups.delete(k);
      ups.add({ doc: this.key, data: merged } satisfies StoredUpdate);
      updates = [merged];
    }
    docs.put({
      ...meta,
      title: this.info.title || meta.title,
      bytes: updates.reduce((n, u) => n + u.byteLength, 0),
      count: updates.length,
      lastOpened: Date.now(),
    } satisfies DocMeta);
    await complete;
    return { updates, localCounter: meta.localCounter, syncedCounter: meta.syncedCounter };
  }

  async append(update: Uint8Array, localCounter: number | null): Promise<void> {
    const tx = this.db.transaction(["docs", "updates"], "readwrite");
    const complete = done(tx);
    tx.objectStore("updates").add({ doc: this.key, data: update } satisfies StoredUpdate);
    const docs = tx.objectStore("docs");
    const meta = (await req<DocMeta | undefined>(docs.get(this.key))) ?? this.fresh();
    meta.bytes += update.byteLength;
    meta.count += 1;
    if (localCounter !== null) meta.localCounter = Math.max(meta.localCounter, localCounter);
    docs.put(meta);
    await complete;
  }

  async markSynced(counter: number, revision: number): Promise<void> {
    const tx = this.db.transaction("docs", "readwrite");
    const complete = done(tx);
    const docs = tx.objectStore("docs");
    const meta = (await req<DocMeta | undefined>(docs.get(this.key))) ?? this.fresh();
    meta.syncedCounter = Math.max(meta.syncedCounter, counter);
    meta.revision = revision;
    docs.put(meta);
    await complete;
  }

  setTitle(title: string) {
    this.info.title = title;
  }
}

export async function openDocStore(workspaceId: string, pageId: string, title: string): Promise<IdbDocStore> {
  const db = await docDb();
  return new IdbDocStore(db, docKey(workspaceId, pageId), { workspaceId, pageId, title });
}

/** LRU by last opened: at most MAX_DOCS docs and MAX_BYTES of updates. Open docs and docs with pending local edits are never evicted. */
export async function enforceLimits(): Promise<number> {
  const db = await docDb();
  const metas = (await listDocs()).sort((a, b) => a.lastOpened - b.lastOpened);
  let count = metas.length;
  let bytes = metas.reduce((n, m) => n + m.bytes, 0);
  const evict: string[] = [];
  for (const m of metas) {
    if (count <= MAX_DOCS && bytes <= MAX_BYTES) break;
    if (openKeys.has(m.key) || hasPending(m)) continue;
    evict.push(m.key);
    count--;
    bytes -= m.bytes;
  }
  if (!evict.length) return 0;
  const tx = db.transaction(["docs", "updates"], "readwrite");
  const complete = done(tx);
  deleteDocsIn(tx, evict);
  await complete;
  return evict.length;
}

/** Rebuild a cached document locally and export it as Markdown (drafts survive lost access). */
export async function draftMarkdown(key: string): Promise<string> {
  const db = await docDb();
  const entries = await req<StoredUpdate[]>(db.transaction("updates").objectStore("updates").index("doc").getAll(key));
  const doc = new Y.Doc();
  Y.transact(doc, () => entries.forEach((e) => Y.applyUpdate(doc, e.data)));
  const md = docMarkdown(doc);
  doc.destroy();
  return md;
}

export const docMarkdown = (doc: Y.Doc) => toMarkdown(yToJSON(doc.getXmlFragment(FRAGMENT)));
