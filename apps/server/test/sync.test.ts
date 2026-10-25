import { FRAGMENT, jsonToY, yToJSON } from "@workspace/core";
import { env, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addMember, api, client, createWorkspace, memoryStore, signUp, until } from "./helpers";

function para(doc: Y.Doc, text: string, id = `b${Math.random().toString(36).slice(2, 10)}`) {
  const frag = doc.getXmlFragment(FRAGMENT);
  frag.insert(frag.length, [jsonToY({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] })]);
}

async function setup() {
  const owner = await signUp();
  const ws = await createWorkspace(owner);
  const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Doc" });
  return { owner, ws, pageId: body.page.id as string };
}

describe("document sync", () => {
  it("converges two editors and acknowledges only after commit", async () => {
    const { owner, ws, pageId } = await setup();
    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const a = client(owner, pageId);
    const b = client(editor, pageId);
    await a.provider.start();
    await b.provider.start();
    await until(() => a.provider.current.phase === "synced" && b.provider.current.phase === "synced", "initial sync");

    para(a.doc, "hello from A");
    para(b.doc, "hello from B");
    await until(() => a.text().includes("hello from B") && b.text().includes("hello from A"), "convergence");
    await until(() => a.provider.current.phase === "synced" && b.provider.current.phase === "synced", "acks");
    expect(a.text()).toBe(b.text());
    expect(Math.max(a.provider.current.revision ?? 0, b.provider.current.revision ?? 0)).toBe(2);

    // The server copy matches and survives eviction of the object (restart/hibernation).
    const stub = env.PAGE.get(env.PAGE.idFromName(pageId));
    await evictDurableObject(stub);
    const read = await api(owner, "GET", `/api/pages/${pageId}/document`);
    expect(JSON.stringify(read.body.doc)).toContain("hello from A");
    expect(JSON.stringify(read.body.doc)).toContain("hello from B");
    a.provider.destroy();
    b.provider.destroy();
  });

  it("treats duplicate and re-sent updates as no-ops", async () => {
    const { owner, pageId } = await setup();
    const a = client(owner, pageId);
    await a.provider.start();
    await until(() => a.provider.current.phase === "synced", "sync");
    para(a.doc, "once");
    await until(() => a.provider.current.phase === "synced" && (a.provider.current.revision ?? 0) >= 1, "first ack");
    const revision = a.provider.current.revision;
    // Reconnect: handshake re-sends everything; nothing new must be recorded.
    a.provider.destroy();
    const again = client(owner, pageId);
    Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(a.doc));
    await again.provider.start();
    await until(() => again.provider.current.phase === "synced", "resync");
    expect(again.provider.current.revision).toBe(revision);
    expect((again.text().match(/once/g) ?? []).length).toBe(1);
    again.provider.destroy();
  });

  it("keeps offline edits on the device and merges them on reconnect", async () => {
    const { owner, ws, pageId } = await setup();
    const other = await signUp();
    await addMember(ws, other, "editor");
    const live = client(other, pageId);
    await live.provider.start();
    await until(() => live.provider.current.phase === "synced", "live sync");

    // Offline client: edits land in its store before any connection exists.
    const store = memoryStore();
    const offline = client(owner, pageId, store);
    let allowConnect = false;
    const provider = new (offline.provider.constructor as typeof import("@workspace/core/sync").SyncProvider)({
      doc: offline.doc,
      store,
      connect: () => {
        if (!allowConnect) throw new Error("offline");
        return import("./helpers").then((h) => h.openSocket(owner, pageId));
      },
      batchMs: 5,
    });
    offline.provider.destroy();
    await provider.start();
    para(offline.doc, "written offline");
    await provider.flushLocal();
    expect(provider.current.phase).toBe("saved-device");
    expect(store.data.localCounter).toBe(1);
    expect(store.data.syncedCounter).toBe(0);

    para(live.doc, "written online meanwhile");
    allowConnect = true;
    provider.reconnectNow();
    await until(() => provider.current.phase === "synced", "offline client synced");
    await until(() => live.text().includes("written offline"), "live sees offline edit");
    expect(offline.doc.getXmlFragment(FRAGMENT).toString()).toContain("written online meanwhile");
    expect(store.data.syncedCounter).toBe(1);
    provider.destroy();
    live.provider.destroy();
  });

  it("rejects viewer writes without acknowledging them", async () => {
    const { owner, ws, pageId } = await setup();
    const viewer = await signUp();
    await addMember(ws, viewer, "viewer");
    const v = client(viewer, pageId);
    await v.provider.start();
    await until(() => v.provider.current.readOnly === "viewer", "read-only hello");
    // Wait past the permission re-check window so the write path is exercised fully.
    para(v.doc, "viewer tries to write");
    await until(() => v.provider.current.pendingLocal, "pending");
    await new Promise((r) => setTimeout(r, 200));
    const read = await api(owner, "GET", `/api/pages/${pageId}/document`);
    expect(JSON.stringify(read.body.doc)).not.toContain("viewer tries to write");
    expect(v.provider.current.pendingLocal).toBe(true);
    v.provider.destroy();
  });

  it("closes the socket of a removed member", async () => {
    const { owner, ws, pageId } = await setup();
    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const e = client(editor, pageId);
    await e.provider.start();
    await until(() => e.provider.current.phase === "synced", "sync");
    const removed = await api(owner, "DELETE", `/api/w/${ws}/members/${editor.id}`);
    expect(removed.status).toBe(200);
    await until(() => e.provider.current.failure === "revoked", "revoked");
    const after = await api(editor, "GET", `/api/pages/${pageId}/document`);
    expect(after.status).toBe(404);
    e.provider.destroy();
  });

  it("delivers MCP-style structured edits to live editors through the same path", async () => {
    const { owner, pageId } = await setup();
    const a = client(owner, pageId);
    await a.provider.start();
    await until(() => a.provider.current.phase === "synced", "sync");
    para(a.doc, "typed by a person", "bperson1");
    await until(() => a.provider.current.phase === "synced" && (a.provider.current.revision ?? 0) >= 1, "ack");
    const stub = env.PAGE.get(env.PAGE.idFromName(pageId));
    const result = await stub.edit(pageId, [{ op: "insert", at: { afterBlockId: "bperson1" }, content: { markdown: "- added by agent" } }], null);
    expect("error" in result).toBe(false);
    await until(() => a.text().includes("added by agent"), "agent edit visible");
    const json = yToJSON(a.doc.getXmlFragment(FRAGMENT));
    expect(json.content!.map((n) => n.type)).toEqual(["paragraph", "bulletList"]);

    const stale = await stub.edit(pageId, [{ op: "delete", blockId: "bperson1" }], 0);
    expect("error" in stale && stale.error.code).toBe("conflict");
    const missing = await stub.edit(pageId, [{ op: "update_text", blockId: "nope", markdown: "x" }], null);
    expect("error" in missing && missing.error.code).toBe("not_found");
    a.provider.destroy();
  });

  it("projects text into search through the alarm outbox", async () => {
    const { owner, ws, pageId } = await setup();
    const a = client(owner, pageId);
    await a.provider.start();
    para(a.doc, "zebra crossing quarterly");
    await until(() => a.provider.current.phase === "synced" && (a.provider.current.revision ?? 0) >= 1, "ack");
    const stub = env.PAGE.get(env.PAGE.idFromName(pageId));
    await runDurableObjectAlarm(stub);
    const hits = await api(owner, "GET", `/api/w/${ws}/search?q=zebra`);
    expect(hits.body.results.map((r: { pageId: string }) => r.pageId)).toContain(pageId);

    // A stale projection cannot overwrite a newer one.
    await env.DB.prepare("UPDATE search_docs SET body = 'newer', revision = 999 WHERE page_id = ?").bind(pageId).run();
    para(a.doc, "older write");
    await until(() => (a.provider.current.revision ?? 0) >= 2 && a.provider.current.phase === "synced", "ack 2");
    await runDurableObjectAlarm(stub);
    const row = await env.DB.prepare("SELECT body FROM search_docs WHERE page_id = ?").bind(pageId).first<{ body: string }>();
    expect(row?.body).toBe("newer");
    a.provider.destroy();
  });
});
