import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as Y from "yjs";
import {
  cacheStatus,
  clearCache,
  docStore,
  evict,
  kvGet,
  kvSet,
  LIMITS,
  loadDoc,
  migrate,
  openDoc,
  pendingDrafts,
  pinDoc,
} from "../lib/doc-store.ts";
import { fakeSql } from "./sqlite-fake.ts";

async function setup(path?: string) {
  const sql = fakeSql(path);
  await migrate(sql);
  return sql;
}

function edit(doc: Y.Doc, text: string): Uint8Array {
  let update: Uint8Array | null = null;
  const h = (u: Uint8Array) => (update = u);
  doc.on("update", h);
  doc.getText("t").insert(doc.getText("t").length, text);
  doc.off("update", h);
  return update!;
}

test("append/load round-trips updates and local counters; markSynced clears pending", async () => {
  const sql = await setup();
  await openDoc(sql, "pg_a", "ws_1", "A");
  const store = docStore(sql, "pg_a");
  const doc = new Y.Doc();
  await store.append(edit(doc, "hello "), 1);
  await store.append(edit(doc, "world"), 2);
  await store.append(edit(new Y.Doc(), "remote"), null);
  let loaded = await store.load();
  assert.equal(loaded.updates.length, 3);
  assert.equal(loaded.localCounter, 2);
  assert.equal(loaded.syncedCounter, 0);
  assert.deepEqual(
    (await pendingDrafts(sql)).map((d) => ({ ...d })),
    [{ pageId: "pg_a", workspaceId: "ws_1", title: "A" }],
  );
  await store.markSynced(2, 7);
  loaded = await store.load();
  assert.equal(loaded.syncedCounter, 2);
  assert.deepEqual(await pendingDrafts(sql), []);
  const restored = await loadDoc(sql, "pg_a");
  assert.ok(restored.getText("t").toString().includes("hello world"));
});

test("load merges more than 100 rows into one without losing content or counters", async () => {
  const sql = await setup();
  await openDoc(sql, "pg_m", "ws_1", "M");
  const store = docStore(sql, "pg_m");
  const doc = new Y.Doc();
  for (let i = 0; i < LIMITS.mergeAbove + 20; i++)
    await store.append(edit(doc, `${i},`), i + 1);
  const first = await store.load();
  assert.equal(first.updates.length, 1);
  assert.equal(first.localCounter, LIMITS.mergeAbove + 20);
  const again = new Y.Doc();
  first.updates.forEach((u) => Y.applyUpdate(again, u));
  assert.equal(again.getText("t").toString(), doc.getText("t").toString());
  const status = await cacheStatus(sql);
  assert.equal(status.bytes, first.updates[0]!.length);
});

test("eviction keeps the newest docs within limits and never drops unsynced edits", async () => {
  const sql = await setup();
  for (let i = 0; i < 25; i++) {
    const id = `pg_${String(i).padStart(2, "0")}`;
    await openDoc(sql, id, "ws_1", id, 1000 + i); // pg_24 is most recent
    await docStore(sql, id).append(edit(new Y.Doc(), "x"), i === 0 ? 1 : null); // pg_00 (oldest) is dirty
  }
  const evicted = await evict(sql, "pg_01");
  assert.ok(!evicted.includes("pg_00"), "dirty doc kept");
  assert.ok(!evicted.includes("pg_01"), "open doc kept");
  assert.equal((await cacheStatus(sql)).docs, LIMITS.docs);
  assert.deepEqual(evicted.sort(), [
    "pg_02",
    "pg_03",
    "pg_04",
    "pg_05",
    "pg_06",
  ]);
  const byBytes = await evict(sql, null, { ...LIMITS, bytes: 0 });
  assert.ok(!byBytes.includes("pg_00"));
  assert.equal((await cacheStatus(sql)).docs, 1);
});

test("clearCache keeps drafts and preferences; kv round-trips JSON", async () => {
  const sql = await setup();
  await openDoc(sql, "pg_d", "ws_1", "D");
  await docStore(sql, "pg_d").append(edit(new Y.Doc(), "draft"), 1);
  await openDoc(sql, "pg_c", "ws_1", "C");
  await docStore(sql, "pg_c").append(edit(new Y.Doc(), "clean"), null);
  await kvSet(sql, "me", { user: { id: "u" } });
  await kvSet(sql, "pref:ws", "ws_1");
  assert.deepEqual(await kvGet(sql, "me"), { user: { id: "u" } });
  await clearCache(sql);
  assert.equal((await cacheStatus(sql)).docs, 1);
  assert.equal(await kvGet(sql, "me"), undefined);
  assert.equal(await kvGet(sql, "pref:ws"), "ws_1");
});

test("acknowledged appends survive closing and reopening the database file (force-quit model)", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ws-store-")), "ws-u.db");
  const a = await setup(path);
  await openDoc(a, "pg_q", "ws_1", "Q");
  const doc = new Y.Doc();
  await docStore(a, "pg_q").append(edit(doc, "typed before kill"), 1);
  a.close(); // no flush/teardown beyond what append() already awaited
  const b = await setup(path);
  const reloaded = await loadDoc(b, "pg_q");
  assert.equal(reloaded.getText("t").toString(), "typed before kill");
  assert.equal((await pendingDrafts(b)).length, 1);
});

test("all mounted sessions survive eviction and clear cache, including repeated page mounts", async () => {
  const sql = await setup();
  for (const id of ["pg_parent", "pg_child", "pg_other"]) {
    await openDoc(sql, id, "ws_1", id);
    await docStore(sql, id).append(edit(new Y.Doc(), id), null);
  }
  const releaseParent = pinDoc(sql, "pg_parent");
  const releaseChild = pinDoc(sql, "pg_child");
  const releaseSecondParent = pinDoc(sql, "pg_parent");
  releaseParent();
  const removed = await evict(sql, null, { ...LIMITS, docs: 0, bytes: 0 });
  assert.deepEqual(removed, ["pg_other"]);
  await clearCache(sql);
  assert.equal((await cacheStatus(sql)).docs, 2);
  assert.ok((await docStore(sql, "pg_parent").load()).updates.length);
  releaseSecondParent();
  releaseChild();
  await clearCache(sql);
  assert.equal((await cacheStatus(sql)).docs, 0);
});
