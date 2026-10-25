import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { addMember, api, createWorkspace, newDatabase, newPage, signUp, socketOutcome, type TestUser, uploadFile } from "./helpers";

type Role = "owner" | "editor" | "viewer" | "outsider";
type Cap = "read" | "write" | "owner";
const EXPECT: Record<Cap, Record<Role, "ok" | number>> = {
  read: { owner: "ok", editor: "ok", viewer: "ok", outsider: 404 },
  write: { owner: "ok", editor: "ok", viewer: 403, outsider: 404 },
  owner: { owner: "ok", editor: 403, viewer: 403, outsider: 404 },
};

let users: Record<Role, TestUser>;
let ws: string;

/** Fresh objects per call (created by the owner) so mutating routes never see each other's leftovers. */
const fx = {
  page: () => newPage(users.owner, ws, { title: "Matrix page" }),
  archived: async () => {
    const p = await fx.page();
    await api(users.owner, "POST", `/api/pages/${p.id}/archive`);
    return p;
  },
  db: () => newDatabase(users.owner, ws),
  record: async () => {
    const db = await fx.db();
    const r = await api(users.owner, "POST", `/api/databases/${db.id}/records`, { values: { p_title: "Row" } });
    return { db, record: r.body.record };
  },
  member: async () => {
    const u = await signUp();
    await addMember(ws, u, "viewer");
    return u;
  },
  invitation: async () => (await api(users.owner, "POST", `/api/w/${ws}/invitations`, { email: `inv-${crypto.randomUUID().slice(0, 8)}@example.com`, role: "editor" })).body.invitation,
};

type Row = [name: string, cap: Cap, ok: number, run: (u: TestUser) => Promise<{ status: number }>];
const rows: Row[] = [
  ["list pages", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/pages`)],
  ["create page", "write", 201, (u) => api(u, "POST", `/api/w/${ws}/pages`, { title: "x" })],
  ["get page", "read", 200, async (u) => api(u, "GET", `/api/pages/${(await fx.page()).id}`)],
  ["rename page", "write", 200, async (u) => api(u, "PATCH", `/api/pages/${(await fx.page()).id}`, { expectedRevision: 1, title: "renamed" })],
  ["move page", "write", 200, async (u) => {
    const [a, b] = [await fx.page(), await fx.page()];
    return api(u, "POST", `/api/pages/${a.id}/move`, { expectedRevision: 1, parentId: b.id });
  }],
  ["archive page", "write", 200, async (u) => api(u, "POST", `/api/pages/${(await fx.page()).id}/archive`)],
  ["restore page", "write", 200, async (u) => api(u, "POST", `/api/pages/${(await fx.archived()).id}/restore`)],
  ["delete page permanently", "owner", 200, async (u) => api(u, "DELETE", `/api/pages/${(await fx.archived()).id}`)],
  ["favorite", "read", 200, async (u) => api(u, "PUT", `/api/pages/${(await fx.page()).id}/favorite`, { favorite: true })],
  ["visit", "read", 200, async (u) => api(u, "POST", `/api/pages/${(await fx.page()).id}/visit`)],
  ["favorites", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/favorites`)],
  ["recents", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/recents`)],
  ["trash", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/trash`)],
  ["read document", "read", 200, async (u) => api(u, "GET", `/api/pages/${(await fx.page()).id}/document`)],
  ["edit document", "write", 200, async (u) =>
    api(u, "POST", `/api/pages/${(await fx.page()).id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: "hi" } }] })],
  ["export markdown", "read", 200, async (u) => api(u, "GET", `/api/pages/${(await fx.page()).id}/export.md`)],
  ["list comments", "read", 200, async (u) => api(u, "GET", `/api/pages/${(await fx.page()).id}/comments`)],
  ["add comment", "write", 201, async (u) => api(u, "POST", `/api/pages/${(await fx.page()).id}/comments`, { body: "hello" })],
  ["upload attachment", "write", 201, async (u) => uploadFile(u, (await fx.page()).id, "png-bytes")],
  ["download attachment", "read", 200, async (u) => {
    const up = await uploadFile(users.owner, (await fx.page()).id, "png-bytes");
    return api(u, "GET", up.body.src);
  }],
  ["create database", "write", 201, (u) => api(u, "POST", `/api/w/${ws}/databases`, { title: "d" })],
  ["get database", "read", 200, async (u) => api(u, "GET", `/api/databases/${(await fx.db()).id}`)],
  ["update schema", "write", 200, async (u) => {
    const db = await fx.db();
    return api(u, "PUT", `/api/databases/${db.id}/schema`, { expectedRevision: db.revision, schema: [...db.schema, { id: "p_notes", name: "Notes", type: "text" }] });
  }],
  ["create view", "write", 201, async (u) => api(u, "POST", `/api/databases/${(await fx.db()).id}/views`, { name: "Mine", type: "table" })],
  ["update view", "write", 200, async (u) => {
    const db = await fx.db();
    return api(u, "PATCH", `/api/databases/${db.id}/views/${db.views[0].id}`, { expectedRevision: 1, name: "Renamed" });
  }],
  ["delete view", "write", 200, async (u) => {
    const db = await fx.db();
    return api(u, "DELETE", `/api/databases/${db.id}/views/${db.views[1].id}`);
  }],
  ["query records", "read", 200, async (u) => api(u, "POST", `/api/databases/${(await fx.db()).id}/query`, {})],
  ["create record", "write", 201, async (u) => api(u, "POST", `/api/databases/${(await fx.db()).id}/records`, { values: { p_title: "r" } })],
  ["get record", "read", 200, async (u) => api(u, "GET", `/api/records/${(await fx.record()).record.id}`)],
  ["update record", "write", 200, async (u) => {
    const { record } = await fx.record();
    return api(u, "PATCH", `/api/records/${record.id}`, { expectedRevision: record.revision, values: { p_status: "o_done" } });
  }],
  ["export csv", "read", 200, async (u) => api(u, "GET", `/api/databases/${(await fx.db()).id}/export.csv`)],
  ["import markdown", "write", 201, (u) => api(u, "POST", `/api/w/${ws}/import/markdown`, { markdown: "# T\n\nbody" })],
  ["import csv", "write", 201, (u) => api(u, "POST", `/api/w/${ws}/import/csv`, { csv: "Name\nA\n", title: "Imported" })],
  ["list members", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/members`)],
  ["change member role", "owner", 200, async (u) => api(u, "PATCH", `/api/w/${ws}/members/${(await fx.member()).id}`, { role: "editor" })],
  ["remove member", "owner", 200, async (u) => api(u, "DELETE", `/api/w/${ws}/members/${(await fx.member()).id}`)],
  ["list invitations", "owner", 200, (u) => api(u, "GET", `/api/w/${ws}/invitations`)],
  ["create invitation", "owner", 201, (u) => api(u, "POST", `/api/w/${ws}/invitations`, { email: "someone@example.com", role: "viewer" })],
  ["revoke invitation", "owner", 200, async (u) => api(u, "DELETE", `/api/w/${ws}/invitations/${(await fx.invitation()).id}`)],
  ["rename workspace", "owner", 200, (u) => api(u, "PATCH", `/api/w/${ws}`, { name: "Renamed team" })],
  ["search", "read", 200, (u) => api(u, "GET", `/api/w/${ws}/search?q=matrix`)],
];

beforeAll(async () => {
  const [owner, editor, viewer, outsider] = await Promise.all([signUp(), signUp(), signUp(), signUp()]);
  users = { owner, editor, viewer, outsider };
  ws = await createWorkspace(owner);
  await addMember(ws, editor, "editor");
  await addMember(ws, viewer, "viewer");
  await createWorkspace(outsider, "Outsider's own");
});

describe("authorization matrix", () => {
  for (const [name, cap, ok, run] of rows) {
    it.each(["owner", "editor", "viewer", "outsider"] as Role[])(`${name} as %s`, async (role) => {
      const res = await run(users[role]);
      const want = EXPECT[cap][role];
      expect(res.status, JSON.stringify(res)).toBe(want === "ok" ? ok : want);
    });
  }

  it("anonymous requests are 401 and cross-site writes are blocked", async () => {
    expect((await api(null, "GET", `/api/w/${ws}/pages`)).status).toBe(401);
    expect((await api(null, "GET", "/api/me")).status).toBe(401);
    const res = await fetchWithOrigin(users.owner, "https://evil.example", `/api/w/${ws}/pages`, { title: "csrf" });
    expect(res.status).toBe(403);
  });

  it("an agent grant can only be revoked by the person who granted it", async () => {
    const grantId = `ag_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
    await env.DB.prepare("INSERT INTO agent_grants (id, workspace_id, user_id, client_id, client_name, scopes, created_at) VALUES (?, ?, ?, 'c', 'Client', 'workspace:read', ?)")
      .bind(grantId, ws, users.editor.id, Date.now())
      .run();
    expect((await api(users.owner, "DELETE", `/api/agent-grants/${grantId}`)).status).toBe(404);
    expect((await api(users.owner, "GET", "/api/agent-grants")).body.grants).toEqual([]);
    expect((await api(users.editor, "GET", "/api/agent-grants")).body.grants.map((g: { id: string }) => g.id)).toEqual([grantId]);
    expect((await api(users.editor, "DELETE", `/api/agent-grants/${grantId}`)).status).toBe(200);
    expect((await api(users.editor, "DELETE", `/api/agent-grants/${grantId}`)).status).toBe(404);
  });
});

async function fetchWithOrigin(user: TestUser, origin: string, path: string, body: unknown) {
  const { SELF } = await import("cloudflare:test");
  return SELF.fetch(`http://localhost:5173${path}`, {
    method: "POST",
    headers: { Origin: origin, Cookie: user.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace isolation", () => {
  it("ids from another workspace look like they do not exist", async () => {
    const intruder = users.owner; // owner of `ws`, not a member of B
    const bOwner = await signUp();
    const b = await createWorkspace(bOwner, "B");
    const bPage = await newPage(bOwner, b, { title: "B secret" });
    const bDb = await newDatabase(bOwner, b);
    const bRec = (await api(bOwner, "POST", `/api/databases/${bDb.id}/records`, { values: { p_title: "B row" } })).body.record;
    const bComment = (await api(bOwner, "POST", `/api/pages/${bPage.id}/comments`, { body: "B comment" })).body.comment;
    const bFile = (await uploadFile(bOwner, bPage.id, "secret-bytes")).body;
    const aPage = await newPage(intruder, ws, { title: "A page" });

    const notFound: [string, string, unknown?][] = [
      ["GET", `/api/pages/${bPage.id}`],
      ["GET", `/api/pages/${bPage.id}/document`],
      ["GET", `/api/pages/${bPage.id}/export.md`],
      ["GET", `/api/pages/${bPage.id}/comments`],
      ["PATCH", `/api/pages/${bPage.id}`, { expectedRevision: 1, title: "pwned" }],
      ["POST", `/api/pages/${bPage.id}/edit`, { ops: [{ op: "insert", at: { position: "end" }, content: { markdown: "x" } }] }],
      ["POST", `/api/pages/${bPage.id}/archive`],
      ["PUT", `/api/pages/${bPage.id}/favorite`, { favorite: true }],
      ["GET", `/api/w/${b}/pages`],
      ["GET", `/api/w/${b}/search?q=secret`],
      ["GET", `/api/w/${b}/members`],
      ["POST", `/api/w/${ws}/pages`, { title: "child", parentId: bPage.id }],
      ["POST", `/api/pages/${aPage.id}/move`, { expectedRevision: 1, parentId: bPage.id }],
      ["DELETE", `/api/pages/${aPage.id}/comments/${bComment.id}`],
      ["DELETE", `/api/pages/${bPage.id}/comments/${bComment.id}`],
      ["GET", bFile.src],
      ["GET", `/api/databases/${bDb.id}`],
      ["POST", `/api/databases/${bDb.id}/query`, {}],
      ["POST", `/api/databases/${bDb.id}/records`, { values: {} }],
      ["GET", `/api/databases/${bDb.id}/export.csv`],
      ["PATCH", `/api/databases/${bDb.id}/views/${bDb.views[0].id}`, { expectedRevision: 1, name: "x" }],
      ["GET", `/api/records/${bRec.id}`],
      ["PATCH", `/api/records/${bRec.id}`, { expectedRevision: bRec.revision, values: { p_title: "pwned" } }],
    ];
    for (const [method, path, body] of notFound) {
      const res = await api(intruder, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/B secret|B row|B comment/);
    }
    // Re-using another workspace's id for an idempotent create is a conflict, never a takeover.
    expect((await api(intruder, "POST", `/api/w/${ws}/pages`, { id: bPage.id, title: "steal" })).status).toBe(409);
    expect((await api(intruder, "POST", `/api/w/${ws}/pages`, { title: "x", afterId: bPage.id })).status).toBe(400);
    expect((await api(intruder, "GET", `/api/w/${ws}/search?q=secret`)).body.results).toEqual([]);

    // Realtime entry points refuse too.
    expect((await socketOutcome(intruder, `/sync/${bPage.id}`)).code).toBe(4404);
    expect((await socketOutcome(intruder, `/sync/pg_doesnotexist0000`)).code).toBe(4404);
    expect((await socketOutcome(intruder, `/events/${b}`)).code).toBe(4403);
    expect((await socketOutcome(intruder, `/events/${ws}`)).code).toBe("open");

    // Nothing in B changed.
    const after = await api(bOwner, "GET", `/api/pages/${bPage.id}`);
    expect(after.body.page.title).toBe("B secret");
    expect(after.body.page.revision).toBe(1);
  });

  it("a member of both workspaces still cannot mix ids across them", async () => {
    const both = users.editor;
    const other = await createWorkspace(both, "Editor's own");
    const otherPage = await newPage(both, other, { title: "elsewhere" });
    const local = await newPage(both, ws, { title: "here" });
    expect((await api(both, "POST", `/api/w/${ws}/pages`, { title: "child", parentId: otherPage.id })).status).toBe(400);
    expect((await api(both, "POST", `/api/pages/${local.id}/move`, { expectedRevision: 1, parentId: otherPage.id })).status).toBe(400);
    expect((await api(both, "GET", `/api/w/${ws}/pages?parentId=${otherPage.id}`)).body.pages).toEqual([]);
  });
});
