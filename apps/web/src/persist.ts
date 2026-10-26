import { type DehydratedState, dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { deleteDb, done, openDb, req } from "./idb";

/** Metadata persisted per account so a visited workspace stays navigable offline. Never page bodies (those live in the doc cache). */
const PERSISTED = new Set(["workspaces", "pages", "favorites", "recents", "page", "database", "hierarchy"]);
const MAX_PAGE_ENTRIES = 150;
const LAST_USER = "ws-last-user";

export const queryDbName = (userId: string) => `ws-query-${userId}`;
export const docDbName = (userId: string) => `ws-cache-${userId}`;

export function lastUserId(): string | null {
  try {
    return localStorage.getItem(LAST_USER);
  } catch {
    return null;
  }
}
export function setLastUserId(id: string | null) {
  try {
    if (id) localStorage.setItem(LAST_USER, id);
    else localStorage.removeItem(LAST_USER);
  } catch {
    /* private mode */
  }
}

const dbs = new Map<string, Promise<IDBDatabase>>();
function db(userId: string) {
  let p = dbs.get(userId);
  if (!p) {
    p = openDb(queryDbName(userId), 1, (d) => d.createObjectStore("kv"));
    dbs.set(userId, p);
  }
  return p;
}

export async function restoreQueries(qc: QueryClient, userId: string): Promise<boolean> {
  try {
    const d = await db(userId);
    const state = await req<DehydratedState | undefined>(d.transaction("kv").objectStore("kv").get("cache"));
    if (state) {
      hydrate(qc, state);
      // Restored data may predate changes made elsewhere: show it, but refetch whatever is mounted.
      void qc.invalidateQueries({ refetchType: "none" });
    }
    return !!state;
  } catch {
    return false;
  }
}

let stopCurrent: (() => void) | null = null;

export function persistQueries(qc: QueryClient, userId: string) {
  stopCurrent?.();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = async () => {
    timer = null;
    const state = dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.status === "success" && PERSISTED.has(String(q.queryKey[0])) });
    // Bound the cache: keep the most recently fetched page details.
    const pages = state.queries.filter((q) => q.queryKey[0] === "page").sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    const drop = new Set(pages.slice(MAX_PAGE_ENTRIES));
    state.queries = state.queries.filter((q) => !drop.has(q));
    try {
      const d = await db(userId);
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(state, "cache");
      await done(tx);
    } catch {
      /* storage full or wiped: offline metadata is best-effort */
    }
  };
  const unsub = qc.getQueryCache().subscribe((e) => {
    const changed = (e.type === "updated" && e.action.type === "success") || e.type === "removed";
    if (changed && PERSISTED.has(String(e.query.queryKey[0]))) timer ??= setTimeout(() => void save(), 700);
  });
  const stop = () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
  stopCurrent = stop;
  return stop;
}

/** Sign-out wipe: this account's metadata + document caches and the service worker caches. */
export async function wipeAccount(userId: string) {
  stopCurrent?.();
  const p = dbs.get(userId);
  dbs.delete(userId);
  if (p) (await p.catch(() => null))?.close();
  const { closeDocDb } = await import("./sync/cache-db");
  await closeDocDb();
  await Promise.all([deleteDb(queryDbName(userId)), deleteDb(docDbName(userId))]);
  if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
  setLastUserId(null);
}
