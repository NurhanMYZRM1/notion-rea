import { FRAGMENT, jsonToY } from "@workspace/core";
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMember, api, BASE, client, createWorkspace, signUp, until } from "./helpers";

const ADMIN = "test-admin-token-0123456789abcdef";
const admin = (path: string, body: unknown = {}, token = ADMIN) =>
  SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });

async function pageWithText(text: string) {
  const owner = await signUp();
  const ws = await createWorkspace(owner);
  const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: `Doc ${text}` });
  const pageId = body.page.id as string;
  const edit = await api(owner, "POST", `/api/pages/${pageId}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: text } }] });
  expect(edit.status).toBe(200);
  await runDurableObjectAlarm(env.PAGE.get(env.PAGE.idFromName(pageId)));
  return { owner, ws, pageId };
}

describe("search", () => {
  it("is workspace-scoped, excludes trash, and survives FTS syntax in queries", async () => {
    const a = await pageWithText("kumquat orchard notes");
    const b = await pageWithText("kumquat secret plans");
    const hits = await api(a.owner, "GET", `/api/w/${a.ws}/search?q=kumquat`);
    expect(hits.body.results.map((h: { pageId: string }) => h.pageId)).toEqual([a.pageId]);
    for (const q of ['"', "*", "kum*", "NEAR(a b)", "-kumquat", "a OR b", "title:x", "(", "日本"]) {
      const r = await api(a.owner, "GET", `/api/w/${a.ws}/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
    }
    const prefix = await api(a.owner, "GET", `/api/w/${a.ws}/search?q=orch`);
    expect(prefix.body.results).toHaveLength(1);
    await api(a.owner, "POST", `/api/pages/${a.pageId}/archive`);
    expect((await api(a.owner, "GET", `/api/w/${a.ws}/search?q=kumquat`)).body.results).toHaveLength(0);
    expect((await api(a.owner, "GET", `/api/w/${b.ws}/search?q=kumquat`)).status).toBe(404); // not a member
  });

  it("finds titles immediately and renamed titles", async () => {
    const owner = await signUp();
    const ws = await createWorkspace(owner);
    const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Quarterly zeppelin review" });
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=zeppelin`)).body.results).toHaveLength(1);
    await api(owner, "PATCH", `/api/pages/${body.page.id}`, { expectedRevision: body.page.revision, title: "Annual blimp review" });
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=blimp`)).body.results).toHaveLength(1);
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=zeppelin`)).body.results).toHaveLength(0);
  });
});

describe("backup and restore", () => {
  it("requires the admin token", async () => {
    expect((await admin("/api/admin/backup", {}, "wrong-token-wrong-token-wrong-tok")).status).toBe(404);
    expect((await admin("/api/admin/backup", {}, "")).status).toBe(404);
  });

  it("backs up changed bodies to R2 and restores them into an emptied object", async () => {
    const { owner, pageId } = await pageWithText("backup me please");
    const run = await (await admin("/api/admin/backup")).json<{ backedUp: number }>();
    expect(run.backedUp).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("SELECT r2_key, revision FROM doc_backups WHERE page_id = ?").bind(pageId).first<{ r2_key: string; revision: number }>();
    expect(row?.revision).toBeGreaterThanOrEqual(1);
    expect(await env.FILES.head(row!.r2_key)).not.toBeNull();
    const second = await (await admin("/api/admin/backup")).json<{ backedUp: number }>();
    expect(second.backedUp).toBe(0); // unchanged pages are not rewritten

    const before = (await api(owner, "GET", `/api/pages/${pageId}/document`)).body.doc;
    const stub = env.PAGE.get(env.PAGE.idFromName(pageId));
    await stub.purge(); // simulate losing the object's storage
    expect(JSON.stringify((await api(owner, "GET", `/api/pages/${pageId}/document`)).body.doc)).not.toContain("backup me");
    const restored = await (await admin("/api/admin/restore", { cursor: null })).json<{ restored: number; missing: string[] }>();
    expect(restored.missing).toEqual([]);
    expect(restored.restored).toBeGreaterThanOrEqual(1);
    expect((await api(owner, "GET", `/api/pages/${pageId}/document`)).body.doc).toEqual(before);
  });

  it("drops backups of permanently deleted pages", async () => {
    const { owner, pageId } = await pageWithText("delete my backup");
    await admin("/api/admin/backup");
    const key = (await env.DB.prepare("SELECT r2_key FROM doc_backups WHERE page_id = ?").bind(pageId).first<{ r2_key: string }>())!.r2_key;
    await api(owner, "POST", `/api/pages/${pageId}/archive`);
    expect((await api(owner, "DELETE", `/api/pages/${pageId}`)).status).toBe(200);
    await admin("/api/admin/backup");
    expect(await env.FILES.head(key)).toBeNull();
  });
});

describe("durability edge cases", () => {
  it("compacts the update log without changing content", async () => {
    const owner = await signUp();
    const ws = await createWorkspace(owner);
    const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Compaction" });
    const pageId = body.page.id as string;
    const stub = env.PAGE.get(env.PAGE.idFromName(pageId));
    for (let i = 0; i < 510; i++) {
      const r = await stub.edit(pageId, [{ op: "insert", at: { position: "end" }, content: { markdown: `line ${i}` } }], null);
      expect("error" in r).toBe(false);
    }
    const before = (await stub.read(pageId)) as { doc: unknown; revision: number };
    expect(before.revision).toBe(510);
    const counts = await runInDurableObject(stub, async (_obj, state) => ({
      updates: Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM updates").one().n),
      chunks: Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM snapshot").one().n),
    }));
    expect(counts.chunks).toBeGreaterThan(0); // compaction ran
    expect(counts.updates).toBeLessThan(500);
    await evictDurableObject(stub);
    const after = await api(owner, "GET", `/api/pages/${pageId}/document`);
    expect(after.body.doc).toEqual(before.doc);
    expect(after.body.revision).toBe(510);
  });

  it("does not apply or acknowledge edits to a trashed page; restore makes it writable", async () => {
    const owner = await signUp();
    const ws = await createWorkspace(owner);
    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Trash me" });
    const c = client(editor, body.page.id);
    await c.provider.start();
    await until(() => c.provider.current.phase === "synced", "sync");
    await api(owner, "POST", `/api/pages/${body.page.id}/archive`);
    await until(() => c.provider.current.readOnly === "archived", "archived notice");
    const frag = c.doc.getXmlFragment(FRAGMENT);
    frag.insert(0, [jsonToY({ type: "paragraph", content: [{ type: "text", text: "while trashed" }] })]);
    await new Promise((r) => setTimeout(r, 300));
    expect(c.provider.current.pendingLocal).toBe(true);
    expect(JSON.stringify((await api(owner, "GET", `/api/pages/${body.page.id}/document`)).body.doc)).not.toContain("while trashed");
    await api(owner, "POST", `/api/pages/${body.page.id}/restore`);
    await until(() => c.provider.current.readOnly === false, "restored notice");
    c.provider.destroy();
    // A reconnecting client re-sends its pending edit, which is now accepted.
    const again = client(editor, body.page.id);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(c.doc));
    await again.provider.start();
    await until(() => again.provider.current.phase === "synced", "resync");
    expect(JSON.stringify((await api(owner, "GET", `/api/pages/${body.page.id}/document`)).body.doc)).toContain("while trashed");
    again.provider.destroy();
  });
});
