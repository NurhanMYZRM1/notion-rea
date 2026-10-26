import { env, SELF } from "cloudflare:test";
import { elementToJSON, FRAGMENT, jsonToY, type PMNode } from "@workspace/core";
import { SyncProvider } from "@workspace/core/sync";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { processPageReferences } from "../src/domain/page-references";
import { archivePage, createPage, movePage } from "../src/domain/pages";
import { addMember, api, BASE, createWorkspace, memoryStore, newDatabase, newPage, signUp, socketOutcome, until } from "./helpers";

const stub = (id: string) => env.PAGE.get(env.PAGE.idFromName(id));
const read = async (id: string): Promise<{ doc: PMNode; revision: number }> => stub(id).read(id);
const refs = async (id: string) => (await read(id)).doc.content?.filter((n) => n.type === "childPage") ?? [];
async function setup() {
  const owner = await signUp();
  return { owner, ws: await createWorkspace(owner) };
}

describe("hierarchy and owning subpages", () => {
  it("paginates metadata, includes records, and returns the authorized ancestor path", async () => {
    const { owner, ws } = await setup();
    const database = await newDatabase(owner, ws);
    const a = (await api(owner, "POST", `/api/databases/${database.id}/records`, {})).body.record;
    const b = (await api(owner, "POST", `/api/databases/${database.id}/records`, {})).body.record;
    const child = await newPage(owner, ws, { parentId: a.id, title: "Nested record page" });
    const first = await api(owner, "GET", `/api/w/${ws}/hierarchy?parentId=${database.id}&limit=1&focusId=${child.id}`);
    expect(first.status).toBe(200);
    expect(first.body.nodes).toHaveLength(1);
    expect(first.body.nodes[0]).toMatchObject({ id: a.id, kind: "record", hasChildren: true });
    expect(first.body.path.map((p: { id: string }) => p.id)).toEqual([database.id, a.id, child.id]);
    expect(first.body.nodes[0]).not.toHaveProperty("doc");
    const second = await api(owner, "GET", `/api/w/${ws}/hierarchy?parentId=${database.id}&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.nodes.map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect(second.body.nextCursor).toBeNull();
    await api(owner, "POST", `/api/pages/${a.id}/archive`);
    expect((await api(owner, "GET", `/api/w/${ws}/hierarchy?parentId=${database.id}`)).body.nodes.map((p: { id: string }) => p.id)).toEqual([b.id]);
  });

  it("creates once at the acknowledged anchor and preserves existing block ids and text", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws);
    await api(owner, "POST", `/api/pages/${parent.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: "Keep this text\n\nAfter this" } }] });
    const before = await read(parent.id);
    const anchor = String(before.doc.content![0]!.attrs!.id);
    const input = { id: "pg_subpageretry00001", title: "Child", afterBlockId: anchor };
    const first = await api(owner, "POST", `/api/pages/${parent.id}/subpages`, input);
    const again = await api(owner, "POST", `/api/pages/${parent.id}/subpages`, input);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(again.body.page).toEqual(first.body.page);
    expect(again.body.parentRevision).toBe(first.body.parentRevision);
    const after = await read(parent.id);
    expect(after.doc.content?.map((n) => n.type)).toEqual(["paragraph", "childPage", "paragraph"]);
    expect(after.doc.content![0]).toEqual(before.doc.content![0]);
    expect(after.doc.content![2]).toEqual(before.doc.content![1]);
    expect(await refs(parent.id)).toHaveLength(1);
    const other = await newPage(owner, ws);
    expect((await api(owner, "POST", `/api/pages/${other.id}/subpages`, input)).status).toBe(409);
    const concurrent = await Promise.all([parent, other].map((p) => api(owner, "POST", `/api/pages/${p.id}/subpages`, { id: "pg_concurrentchild01", title: "One owner" })));
    expect(concurrent.map((r) => r.status).sort()).toEqual([201, 409]);
    const ownerId = concurrent[0]!.status === 201 ? parent.id : other.id;
    expect((await refs(ownerId)).filter((n) => n.attrs?.pageId === "pg_concurrentchild01")).toHaveLength(1);
  });

  it("keeps refs consistent across rename, move, trash, restore and retry", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws);
    const b = await newPage(owner, ws);
    let child = (await api(owner, "POST", `/api/pages/${a.id}/subpages`, { id: "pg_lifecyclechild001", title: "Before" })).body.page;
    const grandchild = await newPage(owner, ws, { parentId: child.id });
    child = (await api(owner, "PATCH", `/api/pages/${child.id}`, { expectedRevision: child.revision, title: "After", icon: "📖" })).body.page;
    expect((await refs(a.id))[0]?.attrs).toMatchObject({ pageId: child.id, title: "After", icon: "📖" });
    child = (await api(owner, "POST", `/api/pages/${child.id}/move`, { expectedRevision: child.revision, parentId: b.id })).body.page;
    expect(await refs(a.id)).toEqual([]);
    expect(await refs(b.id)).toHaveLength(1);
    await api(owner, "POST", `/api/pages/${child.id}/archive`);
    expect(await refs(b.id)).toEqual([]);
    expect((await refs(child.id))[0]?.attrs?.pageId).toBe(grandchild.id);
    await api(owner, "POST", `/api/pages/${child.id}/restore`);
    await api(owner, "POST", `/api/pages/${child.id}/restore`);
    expect(await refs(b.id)).toHaveLength(1);
    expect(await refs(child.id)).toHaveLength(1);
    const exported = await api(owner, "GET", `/api/pages/${b.id}/export.md?format=json`);
    expect(exported.body.markdown).toContain(`[After](/p/${child.id})`);
  });

  it("rejects deletion from a stale owning block after the child moved", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws);
    const b = await newPage(owner, ws);
    const child = await newPage(owner, ws, { parentId: a.id });
    const grandchild = await newPage(owner, ws, { parentId: child.id });
    await api(owner, "POST", `/api/pages/${child.id}/move`, { expectedRevision: child.revision, parentId: b.id });
    const stale = await api(owner, "POST", `/api/pages/${child.id}/archive`, { expectedParentId: a.id });
    expect(stale.status).toBe(409);
    expect((await api(owner, "GET", `/api/pages/${child.id}`)).body.page).toMatchObject({ parentId: b.id, state: "active" });
    expect((await api(owner, "GET", `/api/pages/${grandchild.id}`)).body.page.state).toBe("active");
    expect((await api(owner, "POST", `/api/pages/${child.id}/archive`, { expectedParentId: b.id })).status).toBe(200);
    expect((await api(owner, "POST", `/api/pages/${child.id}/archive`, { expectedParentId: b.id })).status).toBe(200);
    expect((await api(owner, "POST", `/api/pages/${child.id}/archive`, { expectedParentId: a.id })).status).toBe(409);
  });

  it("accepts an empty archive request stream and validates nonempty optional JSON", async () => {
    const { owner, ws } = await setup();
    const page = await newPage(owner, ws);
    const response = await SELF.fetch(`${BASE}/api/pages/${page.id}/archive`, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: BASE, "Content-Length": "0" }, body: "",
    });
    expect(response.status).toBe(200);
    expect((await response.json<{ page: { state: string } }>()).page.state).toBe("archived");
    const invalid = await SELF.fetch(`${BASE}/api/pages/${page.id}/archive`, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: BASE, "Content-Type": "text/plain" }, body: "not JSON",
    });
    expect(invalid.status).toBe(415);
  });

  it("checks owning parent atomically when a move occurs after authorization and metadata read", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws);
    const b = await newPage(owner, ws);
    const child = await newPage(owner, ws, { parentId: a.id });
    const grandchild = await newPage(owner, ws, { parentId: child.id });
    let injected = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("UPDATE pages SET state = 'archived'")) return statement;
          return { bind: (...values: unknown[]) => ({ all: async () => {
            injected = true;
            await target.prepare("UPDATE pages SET parent_id = ?, revision = revision + 1 WHERE id = ?").bind(b.id, child.id).run();
            return statement.bind(...values).all();
          } }) };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(archivePage({ ...env, DB: racingDb }, { kind: "user", userId: owner.id }, child.id, { expectedParentId: a.id }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(injected).toBe(true);
    expect(await env.DB.prepare("SELECT parent_id, state FROM pages WHERE id = ?").bind(child.id).first()).toEqual({ parent_id: b.id, state: "active" });
    expect(await env.DB.prepare("SELECT state FROM pages WHERE id = ?").bind(grandchild.id).first()).toEqual({ state: "active" });
  });

  it("prevents a cycle if the target moves after the move preflight check", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws);
    const b = await newPage(owner, ws);
    let injected = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("UPDATE pages SET parent_id = ?")) return statement;
          return { bind: (...values: unknown[]) => ({ run: async () => {
            injected = true;
            await target.prepare("UPDATE pages SET parent_id = ?, revision = revision + 1 WHERE id = ?").bind(a.id, b.id).run();
            return statement.bind(...values).run();
          } }) };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(movePage({ ...env, DB: racingDb }, { kind: "user", userId: owner.id }, a.id, { expectedRevision: a.revision, parentId: b.id }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(injected).toBe(true);
    expect(await env.DB.prepare("SELECT parent_id FROM pages WHERE id = ?").bind(a.id).first()).toEqual({ parent_id: null });
    expect(await env.DB.prepare("SELECT parent_id FROM pages WHERE id = ?").bind(b.id).first()).toEqual({ parent_id: a.id });
  });

  it("does not create a child if its parent is archived after the create preflight check", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws);
    const id = "pg_parentarchiverace1";
    let injected = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          injected = true;
          await target.prepare("UPDATE pages SET state = 'archived', archive_root = id WHERE id = ?").bind(parent.id).run();
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(createPage({ ...env, DB: racingDb }, { kind: "user", userId: owner.id }, ws, { id, parentId: parent.id, title: "Late child" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(injected).toBe(true);
    expect(await env.DB.prepare("SELECT 1 FROM pages WHERE id = ?").bind(id).first()).toBeNull();
  });

  it("allows record subpages, enforces permissions, and prevents container and workspace misuse", async () => {
    const { owner, ws } = await setup();
    const viewer = await signUp();
    await addMember(ws, viewer, "viewer");
    const database = await newDatabase(owner, ws);
    const record = (await api(owner, "POST", `/api/databases/${database.id}/records`, {})).body.record;
    expect((await api(owner, "POST", `/api/pages/${record.id}/subpages`, { id: "pg_recordchild000001" })).status).toBe(201);
    expect((await api(owner, "POST", `/api/pages/${database.id}/subpages`, { id: "pg_invalidchild00001" })).status).toBe(400);
    expect((await api(viewer, "POST", `/api/pages/${record.id}/subpages`, { id: "pg_viewerchild000001" })).status).toBe(403);
    expect((await api(viewer, "GET", `/api/w/${ws}/hierarchy`)).status).toBe(200);
    const otherWs = await createWorkspace(owner);
    for (const query of [`parentId=${record.id}`, `focusId=${record.id}`]) {
      expect((await api(owner, "GET", `/api/w/${otherWs}/hierarchy?${query}`)).status).toBe(404);
    }
    expect((await api(null, "GET", `/api/w/${ws}/hierarchy`)).status).toBe(401);
  });

  it("protects owning blocks from generic edits and requires compatible document readers", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws);
    await newPage(owner, ws, { parentId: parent.id });
    const doc = await read(parent.id);
    const owning = (await refs(parent.id))[0]!;
    const deletion = await api(owner, "POST", `/api/pages/${parent.id}/edit`, { expectedRevision: doc.revision, ops: [{ op: "delete", blockId: owning.attrs!.id }] });
    expect(deletion.status).toBe(400);
    const copy = await api(owner, "POST", `/api/pages/${parent.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { blocks: [owning] } }] });
    expect(copy.status).toBe(400);
    expect(await refs(parent.id)).toHaveLength(1);
    expect((await socketOutcome(owner, `/sync/${parent.id}`, 100)).code).toBe(4412);
    const modern = await socketOutcome(owner, `/sync/${parent.id}?schema=2`, 100);
    expect(modern.code).toBe("open");
    modern.ws?.close();
  });

  it("retains failed jobs and reconciles the current relationship after interruption without losing text", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws);
    const b = await newPage(owner, ws);
    await api(owner, "POST", `/api/pages/${a.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: "Preserved body" } }] });
    const before = await read(a.id);
    const id = "pg_interruptedchild1";
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,parent_id,title,position,created_at,updated_at)
      VALUES(?, ?, ?, 'Recovered child', 'a0', ?, ?)`).bind(id, ws, a.id, Date.now(), Date.now()).run();
    const failingEnv = { DB: env.DB, PAGE: { idFromName: (v: string) => v, get: () => ({ reconcileChildPages: async () => { throw new Error("Injected connection failure"); } }) } } as unknown as Env;
    await processPageReferences(failingEnv, { parentIds: [a.id] });
    expect(await env.DB.prepare("SELECT attempts FROM page_reference_outbox WHERE parent_id = ?").bind(a.id).first()).toEqual({ attempts: 1 });
    expect(await refs(a.id)).toHaveLength(0);
    await processPageReferences(env, { parentIds: [a.id] });
    const recovered = await read(a.id);
    expect(recovered.doc.content![0]).toEqual(before.doc.content![0]);
    expect(await refs(a.id)).toHaveLength(1);
    await processPageReferences(env, { parentIds: [a.id] });
    expect((await read(a.id)).revision).toBe(recovered.revision);
    // A newer generation enqueued while a projection RPC runs must survive its completion.
    await env.DB.prepare("UPDATE pages SET title = 'Before concurrent edit' WHERE id = ?").bind(id).run();
    const racingEnv = { DB: env.DB, PAGE: { idFromName: (v: string) => v, get: () => ({ reconcileChildPages: async () => {
      await stub(a.id).reconcileChildPages(a.id, ws);
      await env.DB.prepare("UPDATE pages SET title = 'Concurrent edit' WHERE id = ?").bind(id).run();
    } }) } } as unknown as Env;
    await processPageReferences(racingEnv, { parentIds: [a.id] });
    expect(await env.DB.prepare("SELECT 1 FROM page_reference_outbox WHERE parent_id = ?").bind(a.id).first()).not.toBeNull();
    await processPageReferences(env, { parentIds: [a.id] });
    expect((await refs(a.id))[0]?.attrs?.title).toBe("Concurrent edit");
    // A delayed create job must apply the latest metadata, rather than its former desired state.
    await env.DB.prepare("UPDATE pages SET parent_id = ?, title = 'Moved' WHERE id = ?").bind(b.id, id).run();
    await env.DB.prepare("UPDATE pages SET state = 'archived', archive_root = id WHERE id = ?").bind(id).run();
    await processPageReferences(env, { workspaceId: ws });
    expect(await refs(a.id)).toHaveLength(0);
    expect(await refs(b.id)).toHaveLength(0);
    expect(await env.DB.prepare("SELECT 1 FROM page_reference_outbox WHERE workspace_id = ?").bind(ws).first()).toBeNull();
  });

  it("disconnects a mounted legacy reader before adding owning nodes and repairs a socket deletion of a link", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws);
    const old = await socketOutcome(owner, `/sync/${parent.id}`, 50);
    expect(old.code).toBe("open");
    let oldClose = 0;
    old.ws!.addEventListener("close", (event) => { oldClose = event.code; });
    await newPage(owner, ws, { parentId: parent.id });
    await until(() => oldClose === 4412, "legacy client closed");
    const modern = await socketOutcome(owner, `/sync/${parent.id}?schema=2`, 50);
    const state: { state: Uint8Array; revision: number } = await stub(parent.id).exportState();
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, state.state);
    const vector = Y.encodeStateVector(scratch);
    scratch.getXmlFragment("default").delete(0, 1);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(scratch, vector));
    let close = 0;
    modern.ws!.addEventListener("close", (event) => { close = event.code; });
    modern.ws!.send(encoding.toUint8Array(encoder));
    // Accepted, then rebuilt from D1: the link comes back and the session stays usable.
    await until(async () => (await read(parent.id)).revision > state.revision && (await refs(parent.id)).length === 1, "link repaired");
    expect(close).toBe(0);
    scratch.destroy();
  });

  it("keeps syncing after an offline reorder of a link whose subpage was trashed meanwhile", async () => {
    const { owner, ws } = await setup();
    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const parent = await newPage(owner, ws);
    await api(owner, "POST", `/api/pages/${parent.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: "first para" } }] });
    await api(owner, "POST", `/api/pages/${parent.id}/subpages`, { id: "pg_reorderedchild0001", title: "Child" });
    const connect = async () => {
      const res = await SELF.fetch(`${BASE}/sync/${parent.id}?schema=2`, { headers: { Upgrade: "websocket", Cookie: editor.cookie, Origin: BASE } });
      res.webSocket!.accept();
      return res.webSocket!;
    };
    const doc = new Y.Doc();
    const store = memoryStore();
    let provider = new SyncProvider({ doc, store, connect, batchMs: 5 });
    await provider.start();
    const frag = doc.getXmlFragment(FRAGMENT);
    const linkIndex = () => frag.toArray().findIndex((e) => e instanceof Y.XmlElement && e.nodeName === "childPage");
    await until(() => provider.current.phase === "synced" && linkIndex() >= 0, "link synced");
    provider.destroy();
    // Someone else trashes the subpage while this device is offline; the server removes the link.
    expect((await api(owner, "POST", "/api/pages/pg_reorderedchild0001/archive")).status).toBe(200);
    // Offline: drag the (now stale) link to the top, then keep typing. The editor allows reordering links.
    provider = new SyncProvider({ doc, store, connect: () => Promise.reject(new Error("offline")), batchMs: 5 });
    await provider.start();
    const link = elementToJSON(frag.get(linkIndex()) as Y.XmlElement);
    doc.transact(() => {
      frag.delete(linkIndex(), 1);
      frag.insert(0, [jsonToY(link)]);
    });
    frag.insert(frag.length, [jsonToY({ type: "paragraph", content: [{ type: "text", text: "typed offline" }] })]);
    await provider.flushLocal();
    provider.destroy();
    provider = new SyncProvider({ doc, store, connect, batchMs: 5 });
    await provider.start();
    await until(() => provider.current.phase === "synced" || provider.current.phase === "failed", "reconnect settles", 8000);
    expect(provider.current.failure).toBeNull();
    expect(provider.current.pendingLocal).toBe(false);
    const server = await read(parent.id);
    expect(JSON.stringify(server.doc)).toContain("typed offline");
    expect(await refs(parent.id)).toHaveLength(0); // the server stays authoritative: the trashed page's link is gone
    await until(() => linkIndex() < 0, "repair reaches the device");
    provider.destroy();
  });

  it("bounds a ten-thousand-record hierarchy without reading or creating record documents", async () => {
    const { owner, ws } = await setup();
    const database = await newDatabase(owner, ws);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `pg_largegraph${String(i).padStart(8, "0")}`, position: String(i).padStart(8, "0") }));
    await env.DB.prepare(`INSERT INTO pages(id, workspace_id, parent_id, database_id, title, position, created_at, updated_at)
      SELECT json_extract(value, '$.id'), ?, ?, ?, 'Record', json_extract(value, '$.position'), 0, 0 FROM json_each(?)`)
      .bind(ws, database.id, database.id, JSON.stringify(rows)).run();
    const result = await api(owner, "GET", `/api/w/${ws}/hierarchy?parentId=${database.id}&limit=200`);
    expect(result.status).toBe(200);
    expect(result.body.nodes).toHaveLength(200);
    expect(result.body.nextCursor).toBeTruthy();
    expect(result.body.nodes.every((n: { kind: string; hasChildren: boolean }) => n.kind === "record" && !n.hasChildren)).toBe(true);
    expect(await env.DB.prepare("SELECT 1 FROM page_reference_outbox WHERE workspace_id = ?").bind(ws).first()).toBeNull();
  });

  it("prevents deep cycles and archives every descendant beyond the former depth limit", async () => {
    const { owner, ws } = await setup();
    const root = await newPage(owner, ws);
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `pg_deephierarchy${String(i).padStart(8, "0")}`, parent: i ? `pg_deephierarchy${String(i - 1).padStart(8, "0")}` : root.id }));
    await env.DB.prepare(`INSERT INTO pages(id,workspace_id,parent_id,title,position,created_at,updated_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parent'), 'Nested', 'a0', 0, 0 FROM json_each(?)`)
      .bind(ws, JSON.stringify(rows)).run();
    const deepest = rows.at(-1)!.id;
    const graph = await api(owner, "GET", `/api/w/${ws}/hierarchy?focusId=${deepest}`);
    expect(graph.body.path).toHaveLength(206);
    expect(graph.body.path[0].id).toBe(root.id);
    const detail = await api(owner, "GET", `/api/pages/${deepest}`);
    expect(detail.body.page.breadcrumbs).toHaveLength(205);
    expect(detail.body.page.breadcrumbs[0].id).toBe(root.id);
    expect((await api(owner, "POST", `/api/pages/${root.id}/move`, { expectedRevision: root.revision, parentId: deepest })).status).toBe(400);
    expect((await api(owner, "POST", `/api/pages/${root.id}/archive`)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE workspace_id = ? AND state = 'archived'").bind(ws).first()).toEqual({ n: 206 });
  });
});
