import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, api, BASE, client, createWorkspace, newPage, signUp, socketOutcome, until, uploadFile } from "./helpers";

async function setup() {
  const owner = await signUp();
  const ws = await createWorkspace(owner);
  return { owner, ws };
}
const children = async (u: Awaited<ReturnType<typeof signUp>>, ws: string, parentId?: string) =>
  ((await api(u, "GET", `/api/w/${ws}/pages${parentId ? `?parentId=${parentId}` : ""}`)).body.pages as { title: string; id: string }[]).map((p) => p.title);
const stub = (id: string) => env.PAGE.get(env.PAGE.idFromName(id));
const insert = (markdown: string) => ({ ops: [{ op: "insert", at: { position: "end" }, content: { markdown } }] });

describe("page lifecycle", () => {
  it("creates idempotently on a client id", async () => {
    const { owner, ws } = await setup();
    const id = "pg_clientgenerated0001";
    const a = await api(owner, "POST", `/api/w/${ws}/pages`, { id, title: "Once" });
    const b = await api(owner, "POST", `/api/w/${ws}/pages`, { id, title: "Twice" });
    expect(a.status).toBe(201);
    expect(b.body.page).toEqual(a.body.page);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE id = ?").bind(id).first<{ n: number }>())!.n).toBe(1);
    expect(await children(owner, ws)).toEqual(["Once"]);

    const other = await setup();
    expect((await api(other.owner, "POST", `/api/w/${other.ws}/pages`, { id, title: "Steal" })).status).toBe(409);
    expect((await api(owner, "POST", `/api/w/${ws}/pages`, { id: "bad id", title: "x" })).status).toBe(400);
  });

  it("orders siblings with afterId and rejects move cycles", async () => {
    const { owner, ws } = await setup();
    const a = await newPage(owner, ws, { title: "A" });
    const b = await newPage(owner, ws, { title: "B" });
    const c = await newPage(owner, ws, { title: "C" });
    await newPage(owner, ws, { title: "D", afterId: a.id });
    expect(await children(owner, ws)).toEqual(["A", "D", "B", "C"]);
    expect((await api(owner, "POST", `/api/pages/${c.id}/move`, { expectedRevision: c.revision, parentId: null, afterId: a.id })).status).toBe(200);
    expect(await children(owner, ws)).toEqual(["A", "C", "D", "B"]);
    // Insert at the front: after nothing means append, so use move + afterId of the last to verify append.
    expect((await api(owner, "POST", `/api/pages/${a.id}/move`, { expectedRevision: a.revision, parentId: null, afterId: b.id })).status).toBe(200);
    expect(await children(owner, ws)).toEqual(["C", "D", "B", "A"]);

    // Cycles: into itself, into a descendant, into a grandchild.
    const child = await newPage(owner, ws, { title: "child", parentId: b.id });
    const grandchild = await newPage(owner, ws, { title: "grandchild", parentId: child.id });
    const bNow = (await api(owner, "GET", `/api/pages/${b.id}`)).body.page;
    for (const target of [b.id, child.id, grandchild.id]) {
      const res = await api(owner, "POST", `/api/pages/${b.id}/move`, { expectedRevision: bNow.revision, parentId: target });
      expect(res.status, target).toBe(400);
    }
    // Stale revision → conflict carrying the current page.
    const stale = await api(owner, "POST", `/api/pages/${b.id}/move`, { expectedRevision: bNow.revision + 7, parentId: c.id });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current.id).toBe(b.id);
    expect((await api(owner, "GET", `/api/pages/${grandchild.id}`)).body.page.breadcrumbs.map((x: { title: string }) => x.title)).toEqual(["B", "child"]);
    // A page in the trash cannot be moved.
    await api(owner, "POST", `/api/pages/${c.id}/archive`);
    const cNow = (await api(owner, "GET", `/api/pages/${c.id}`)).body.page;
    expect((await api(owner, "POST", `/api/pages/${c.id}/move`, { expectedRevision: cNow.revision, parentId: a.id })).status).toBe(409);
  });

  it("archives a subtree, lists only roots in the trash, and restores from the root only", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws, { title: "Parent" });
    const child = await newPage(owner, ws, { title: "Child", parentId: parent.id });
    const grandchild = await newPage(owner, ws, { title: "Grandchild", parentId: child.id });
    const earlier = await newPage(owner, ws, { title: "Trashed earlier", parentId: parent.id });
    await api(owner, "POST", `/api/pages/${earlier.id}/archive`);

    const archived = await api(owner, "POST", `/api/pages/${parent.id}/archive`);
    expect(archived.body.page.state).toBe("archived");
    expect(await children(owner, ws)).toEqual([]);
    for (const p of [child, grandchild]) expect((await api(owner, "GET", `/api/pages/${p.id}`)).body.page.state).toBe("archived");
    const trash = (await api(owner, "GET", `/api/w/${ws}/trash`)).body.pages.map((p: { title: string }) => p.title);
    expect(trash.sort()).toEqual(["Parent", "Trashed earlier"]);
    // Archiving again is a no-op.
    expect((await api(owner, "POST", `/api/pages/${parent.id}/archive`)).body.page.revision).toBe(archived.body.page.revision);

    const fromChild = await api(owner, "POST", `/api/pages/${child.id}/restore`);
    expect(fromChild.status).toBe(400);
    expect(fromChild.body.error.details).toEqual({ archiveRoot: parent.id });

    expect((await api(owner, "POST", `/api/pages/${parent.id}/restore`)).body.page.state).toBe("active");
    expect(await children(owner, ws, parent.id)).toEqual(["Child"]);
    expect(await children(owner, ws, child.id)).toEqual(["Grandchild"]);
    // What was trashed on its own stays in the trash.
    expect((await api(owner, "GET", `/api/w/${ws}/trash`)).body.pages.map((p: { title: string }) => p.title)).toEqual(["Trashed earlier"]);
  });

  it("restores to the top level when the parent is gone", async () => {
    const { owner, ws } = await setup();
    const parent = await newPage(owner, ws, { title: "Parent" });
    const child = await newPage(owner, ws, { title: "Child", parentId: parent.id });
    await api(owner, "POST", `/api/pages/${child.id}/archive`);
    await api(owner, "POST", `/api/pages/${parent.id}/archive`);
    expect((await api(owner, "DELETE", `/api/pages/${parent.id}`)).body).toEqual({ deleted: 1 });
    const restored = await api(owner, "POST", `/api/pages/${child.id}/restore`);
    expect(restored.body.page.parentId).toBeNull();
    expect(await children(owner, ws)).toEqual(["Child"]);

    // Parent archived (not deleted) → also top level.
    const p2 = await newPage(owner, ws, { title: "P2" });
    const c2 = await newPage(owner, ws, { title: "C2", parentId: p2.id });
    await api(owner, "POST", `/api/pages/${c2.id}/archive`);
    await api(owner, "POST", `/api/pages/${p2.id}/archive`);
    expect((await api(owner, "POST", `/api/pages/${c2.id}/restore`)).body.page.parentId).toBeNull();
  });

  it("permanent delete leaves a tombstone and removes content, search, comments and files", async () => {
    const { owner, ws } = await setup();
    const page = await newPage(owner, ws, { title: "Doomed walrus" });
    const sub = await newPage(owner, ws, { title: "Doomed child", parentId: page.id });
    expect((await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("walrus body text"))).status).toBe(200);
    await runDurableObjectAlarm(stub(page.id));
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=walrus`)).body.results).toHaveLength(1);
    await api(owner, "POST", `/api/pages/${page.id}/comments`, { body: "bye" });
    await api(owner, "PUT", `/api/pages/${page.id}/favorite`, { favorite: true });
    const file = (await uploadFile(owner, sub.id, "child-file")).body;
    const key = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(file.id).first<{ r2_key: string }>())!.r2_key;
    // A projection is pending when the page is deleted.
    await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("late edit"));

    expect((await api(owner, "DELETE", `/api/pages/${page.id}`)).status).toBe(400); // not in the trash yet
    await api(owner, "POST", `/api/pages/${page.id}/archive`);
    expect((await api(owner, "DELETE", `/api/pages/${sub.id}`)).status).toBe(400); // not a trash root
    expect((await api(owner, "DELETE", `/api/pages/${page.id}`)).body).toEqual({ deleted: 2 });

    for (const id of [page.id, sub.id]) {
      const row = await env.DB.prepare("SELECT state, title, props FROM pages WHERE id = ?").bind(id).first();
      expect(row).toEqual({ state: "deleted", title: "", props: "{}" });
      expect(await env.DB.prepare("SELECT 1 FROM search_docs WHERE page_id = ?").bind(id).first()).toBeNull();
    }
    expect(await env.DB.prepare("SELECT 1 FROM comments WHERE page_id = ?").bind(page.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM attachments WHERE page_id = ?").bind(sub.id).first()).toBeNull();
    expect(await env.FILES.get(key)).toBeNull();
    // The late alarm must not resurrect anything.
    await runDurableObjectAlarm(stub(page.id));
    expect(await env.DB.prepare("SELECT 1 FROM search_docs WHERE page_id = ?").bind(page.id).first()).toBeNull();
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=walrus`)).body.results).toEqual([]);
    // The page object is empty and still answers.
    expect(await stub(page.id).read(page.id)).toEqual({ doc: { type: "doc", content: [] }, revision: 0 });

    for (const [method, path] of [
      ["GET", `/api/pages/${page.id}`],
      ["GET", `/api/pages/${page.id}/document`],
      ["POST", `/api/pages/${page.id}/restore`],
      ["DELETE", `/api/pages/${page.id}`],
      ["GET", file.src],
    ] as const) {
      expect((await api(owner, method, path)).status, `${method} ${path}`).toBe(404);
    }
    expect((await socketOutcome(owner, `/sync/${page.id}`)).code).toBe(4404);
    expect((await api(owner, "GET", `/api/w/${ws}/trash`)).body.pages).toEqual([]);
    expect((await api(owner, "GET", `/api/w/${ws}/favorites`)).body.pages).toEqual([]);
    // Re-creating with the tombstone's id cannot bring it back.
    expect((await api(owner, "POST", `/api/w/${ws}/pages`, { id: page.id, title: "Back?" })).status).toBe(409);
    expect((await env.DB.prepare("SELECT state FROM pages WHERE id = ?").bind(page.id).first<{ state: string }>())!.state).toBe("deleted");
  });

  it("refuses edits to trashed pages even with no editor open, and accepts them again after restore", async () => {
    const { owner, ws } = await setup();
    const page = await newPage(owner, ws, { title: "Quiet" });
    expect((await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("one"))).status).toBe(200);
    await api(owner, "POST", `/api/pages/${page.id}/archive`);
    expect((await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("while trashed"))).status).toBe(409);
    await api(owner, "POST", `/api/pages/${page.id}/restore`);
    expect((await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("after restore"))).status).toBe(200);

    // Archive with an editor open (the object learns the state), restore after it closed.
    const live = client(owner, page.id);
    await live.provider.start();
    await until(() => live.provider.current.phase === "synced", "sync");
    await api(owner, "POST", `/api/pages/${page.id}/archive`);
    await until(() => live.provider.current.readOnly === "archived", "read-only");
    live.provider.destroy();
    await until(async () => !(await env.DB.prepare("SELECT 1 FROM doc_sessions WHERE page_id = ?").bind(page.id).first()), "session closed");
    await api(owner, "POST", `/api/pages/${page.id}/restore`);
    const res = await api(owner, "POST", `/api/pages/${page.id}/edit`, insert("restored again"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const doc = JSON.stringify((await api(owner, "GET", `/api/pages/${page.id}/document`)).body.doc);
    expect(doc).toContain("restored again");
    expect(doc).not.toContain("while trashed");
  });

  it("validates list parameters without crashing", async () => {
    const { owner, ws } = await setup();
    const page = await newPage(owner, ws);
    expect((await api(owner, "GET", `/api/w/${ws}/pages?parentId=nope`)).status).toBe(400);
    expect((await api(owner, "GET", `/api/w/${ws}/pages?limit=abc`)).status).toBe(200);
    expect((await api(owner, "GET", `/api/pages/${page.id}/comments?before=abc`)).status).toBe(200);
    expect((await api(owner, "PATCH", `/api/pages/${page.id}`, "not json")).status).toBe(400);
    const textBody = await SELF.fetch(`${BASE}/api/pages/${page.id}`, { method: "PATCH", headers: { Origin: BASE, Cookie: owner.cookie, "Content-Type": "text/plain" }, body: "{}" });
    expect(textBody.status).toBe(415);
  });
});

describe("comments", () => {
  it("are idempotent on a client id", async () => {
    const { owner, ws } = await setup();
    const page = await newPage(owner, ws);
    const other = await newPage(owner, ws);
    const id = "cm_retrysafe00000001";
    const a = await api(owner, "POST", `/api/pages/${page.id}/comments`, { id, body: "first" });
    const b = await api(owner, "POST", `/api/pages/${page.id}/comments`, { id, body: "first" });
    expect(a.status).toBe(201);
    expect(b.body.comment).toEqual(a.body.comment);
    expect((await api(owner, "GET", `/api/pages/${page.id}/comments`)).body.comments).toHaveLength(1);
    expect((await api(owner, "POST", `/api/pages/${other.id}/comments`, { id, body: "elsewhere" })).status).toBe(409);
    expect((await api(owner, "POST", `/api/pages/${page.id}/comments`, { body: "   " })).status).toBe(400);
  });

  it("can be deleted by their author or an owner only", async () => {
    const { owner, ws } = await setup();
    const [editor, editor2, viewer] = [await signUp(), await signUp(), await signUp()];
    await addMember(ws, editor, "editor");
    await addMember(ws, editor2, "editor");
    await addMember(ws, viewer, "viewer");
    const page = await newPage(owner, ws);
    const mine = (await api(editor, "POST", `/api/pages/${page.id}/comments`, { body: "editor's" })).body.comment;
    const ownerComment = (await api(owner, "POST", `/api/pages/${page.id}/comments`, { body: "owner's" })).body.comment;
    const path = (c: { id: string }) => `/api/pages/${page.id}/comments/${c.id}`;
    expect((await api(editor2, "DELETE", path(mine))).status).toBe(403);
    expect((await api(viewer, "DELETE", path(mine))).status).toBe(403);
    expect((await api(editor, "DELETE", path(ownerComment))).status).toBe(403);
    expect((await api(editor, "DELETE", path(mine))).status).toBe(200);
    expect((await api(editor, "DELETE", path(mine))).status).toBe(404);
    const again = (await api(editor, "POST", `/api/pages/${page.id}/comments`, { body: "editor again" })).body.comment;
    expect((await api(owner, "DELETE", path(again))).status).toBe(200);
    expect((await api(owner, "GET", `/api/pages/${page.id}/comments`)).body.comments.map((c: { body: string }) => c.body)).toEqual(["owner's"]);
    await api(owner, "POST", `/api/pages/${page.id}/archive`);
    expect((await api(owner, "POST", `/api/pages/${page.id}/comments`, { body: "in trash" })).status).toBe(409);
  });
});
