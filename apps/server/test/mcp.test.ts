import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FRAGMENT, jsonToY } from "@workspace/core";
import { addMember, api, BASE, client, createWorkspace, signUp, type TestUser, until } from "./helpers";

const REDIRECT = "http://127.0.0.1:9999/callback";
const RESOURCE = `${BASE}/mcp`;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function register(name = "Test Agent"): Promise<string> {
  const res = await SELF.fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function beginAuthorize(user: TestUser, clientId: string, scope = "workspace:read") {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st4te", scope, resource: RESOURCE });
  const res = await SELF.fetch(`${BASE}/authorize?${q}`, { headers: { Cookie: user.cookie }, redirect: "manual" });
  const html = await res.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, handle, verifier, cookie: [user.cookie, cookiesOf(res)].filter(Boolean).join("; ") };
}

async function decide(cookie: string, handle: string, fields: Record<string, string | string[]>) {
  const form = new URLSearchParams({ handle });
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) form.append(k, x);
  return SELF.fetch(`${BASE}/authorize`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", Origin: BASE }, body: form, redirect: "manual" });
}

async function token(body: Record<string, string>) {
  const res = await SELF.fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  return { status: res.status, body: (await res.json()) as { access_token: string; refresh_token: string; scope: string; error?: string } };
}

/** Full browser-style authorization: consent with chosen workspace/scopes → code → tokens. */
async function authorize(user: TestUser, workspaceId: string, extraScopes: string[] = [], requested = "workspace:read") {
  const clientId = await register();
  const start = await beginAuthorize(user, clientId, requested);
  expect(start.res.status).toBe(200);
  const res = await decide(start.cookie, start.handle, { workspace: workspaceId, scope: extraScopes, decision: "approve" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st4te");
  expect(location.searchParams.get("iss")).toBeTruthy();
  const tokens = await token({ grant_type: "authorization_code", code: location.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: start.verifier, resource: RESOURCE });
  expect(tokens.status).toBe(200);
  return { clientId, ...tokens.body };
}

let rpcId = 0;
async function mcp(accessToken: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(RESOURCE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      // In-process SELF.fetch sends no Host header; real requests always do (the handler validates it).
      Host: new URL(BASE).host,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body: any = null;
  if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean).at(-1);
    body = data ? JSON.parse(data) : null;
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}

async function call(accessToken: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(accessToken, "tools/call", { name, arguments: args });
  return { ...r, result: r.body?.result as { isError?: boolean; structuredContent?: any } | undefined };
}

async function setup() {
  const owner = await signUp();
  const ws = await createWorkspace(owner, "Agents");
  return { owner, ws };
}

describe("MCP over OAuth", () => {
  it("cannot use generic block edits to bypass subpage lifecycle permissions", async () => {
    const { owner, ws } = await setup();
    const parent = (await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Parent" })).body.page;
    const child = (await api(owner, "POST", `/api/pages/${parent.id}/subpages`, { id: "pg_mcpowningchild001", title: "Protected" })).body.page;
    const document = (await api(owner, "GET", `/api/pages/${parent.id}/document`)).body;
    const block = document.doc.content.find((n: { type: string }) => n.type === "childPage");
    const { access_token: at } = await authorize(owner, ws, ["workspace:write"]);
    const deleted = await call(at, "edit_blocks", { pageId: parent.id, expectedRevision: document.revision, ops: [{ op: "delete", blockId: block.attrs.id }] });
    expect(deleted.result?.structuredContent.error.code).toBe("invalid_input");
    const forged = await call(at, "edit_blocks", { pageId: parent.id, ops: [{ op: "insert", at: { position: "end" }, content: { blocks: [block] } }] });
    expect(forged.result?.structuredContent.error.code).toBe("invalid_input");
    expect((await api(owner, "GET", `/api/pages/${child.id}`)).body.page.state).toBe("active");
  });

  it("rejects unauthenticated requests with a resource-metadata challenge", async () => {
    const r = await mcp(null, "tools/list");
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toMatch(/resource_metadata=/);
    const meta = await (await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json<{ resource: string; scopes_supported: string[] }>();
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.scopes_supported).toEqual(["workspace:read"]);
  });

  it("runs the full flow: consent, tools, idempotent create, block edits, databases, comments", async () => {
    const { owner, ws } = await setup();
    const { access_token: at, scope } = await authorize(owner, ws, ["workspace:write"]);
    expect(scope.split(" ").sort()).toEqual(["workspace:read", "workspace:write"]);

    const init = await mcp(at, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    const list = await mcp(at, "tools/list");
    const tools = list.body.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["workspace_info", "search", "read_page", "edit_blocks", "query_records", "add_comment", "archive_page"]));
    expect(tools.find((t) => t.name === "read_page")!.annotations?.readOnlyHint).toBe(true);

    const info = await call(at, "workspace_info", {});
    expect(info.result?.structuredContent).toMatchObject({ workspaceId: ws, role: "owner" });

    const created = await call(at, "create_page", { title: "From agent", markdown: "# ignored heading\n\nFirst paragraph\n\n- item", idempotencyKey: "key-0001-abcdef" });
    expect(created.result?.isError).toBeFalsy();
    const pageId = created.result!.structuredContent.page.id as string;
    const again = await call(at, "create_page", { title: "From agent", markdown: "dup", idempotencyKey: "key-0001-abcdef" });
    expect(again.result!.structuredContent.page.id).toBe(pageId);

    const read = await call(at, "read_page", { pageId });
    const { revision, blocks } = read.result!.structuredContent as { revision: number; blocks: { id: string; type: string; markdown?: string }[] };
    const para = blocks.find((b) => b.markdown === "First paragraph")!;
    expect(para.id).toBeTruthy();

    const edited = await call(at, "edit_blocks", { pageId, expectedRevision: revision, ops: [{ op: "update_text", blockId: para.id, markdown: "Edited **by** agent" }] });
    expect(edited.result?.isError).toBeFalsy();
    const stale = await call(at, "edit_blocks", { pageId, expectedRevision: revision, ops: [{ op: "delete", blockId: para.id }] });
    expect(stale.result?.isError).toBe(true);
    expect(stale.result!.structuredContent.error.code).toBe("conflict");
    const missing = await call(at, "edit_blocks", { pageId, ops: [{ op: "insert", at: { afterBlockId: "nope" }, content: { markdown: "x" } }] });
    expect(missing.result!.structuredContent.error.code).toBe("not_found");
    const noRev = await call(at, "edit_blocks", { pageId, ops: [{ op: "delete", blockId: para.id }] });
    expect(noRev.result!.structuredContent.error.code).toBe("invalid_input");

    const db = await call(at, "create_database", { title: "Tasks", idempotencyKey: "db-key-000001" });
    const database = db.result!.structuredContent.database as { id: string; schema: { id: string; type: string; options?: { id: string }[] }[] };
    const status = database.schema.find((p) => p.type === "status")!;
    const rec = await call(at, "create_record", { databaseId: database.id, values: { p_title: "Ship it", [status.id]: status.options![1]!.id }, idempotencyKey: "rec-key-00001" });
    const record = rec.result!.structuredContent.record as { id: string; revision: number };
    const q = await call(at, "query_records", { databaseId: database.id, filters: [{ propId: status.id, op: "is", value: status.options![1]!.id }] });
    expect(q.result!.structuredContent.records).toHaveLength(1);
    const upd = await call(at, "update_record", { recordId: record.id, expectedRevision: record.revision, values: { p_title: "Shipped" } });
    expect(upd.result?.isError).toBeFalsy();
    const conflict = await call(at, "update_record", { recordId: record.id, expectedRevision: record.revision, values: { p_title: "Again" } });
    expect(conflict.result!.structuredContent.error.code).toBe("conflict");

    const comment = await call(at, "add_comment", { pageId, body: "Looks good", idempotencyKey: "cmt-key-00001" });
    expect(comment.result?.isError).toBeFalsy();
    const comments = await api(owner, "GET", `/api/pages/${pageId}/comments`);
    expect(comments.body.comments[0].author.name).toMatch(/via agent/);
  });

  it("requires the archive scope per tool (HTTP 403 step-up challenge)", async () => {
    const { owner, ws } = await setup();
    const { access_token: readWrite } = await authorize(owner, ws, ["workspace:write"]);
    const page = await call(readWrite, "create_page", { title: "Doomed" });
    const pageId = page.result!.structuredContent.page.id;
    const denied = await mcp(readWrite, "tools/call", { name: "archive_page", arguments: { pageId } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toMatch(/insufficient_scope/);
    expect(denied.headers.get("WWW-Authenticate")).toMatch(/workspace:archive/);
    const { access_token: withArchive } = await authorize(owner, ws, ["workspace:write", "workspace:archive"]);
    const ok = await call(withArchive, "archive_page", { pageId });
    expect(ok.result?.isError).toBeFalsy();
    expect(ok.result!.structuredContent.page.state).toBe("archived");

    const readOnly = (await authorize(owner, ws, [])).access_token;
    const write = await mcp(readOnly, "tools/call", { name: "create_page", arguments: { title: "nope" } });
    expect(write.status).toBe(403);
  });

  it("limits a viewer's agent to reading even with write scope", async () => {
    const { owner, ws } = await setup();
    const viewer = await signUp();
    await addMember(ws, viewer, "viewer");
    const { access_token: at } = await authorize(viewer, ws, ["workspace:write"]);
    const r = await call(at, "create_page", { title: "viewer attempt" });
    expect(r.result?.isError).toBe(true);
    expect(r.result!.structuredContent.error.code).toBe("forbidden");
    expect((await call(at, "search", { query: "anything" })).result?.isError).toBeFalsy();
    void owner;
  });

  it("handles deny, reused consent handles and refresh rotation", async () => {
    const { owner, ws } = await setup();
    const clientId = await register();
    const start = await beginAuthorize(owner, clientId);
    const denied = await decide(start.cookie, start.handle, { workspace: ws, decision: "deny" });
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    const reuse = await decide(start.cookie, start.handle, { workspace: ws, decision: "approve" });
    expect(reuse.status).toBe(400);
    expect(reuse.headers.get("Location")).toBeNull();

    const other = await signUp();
    const foreignWs = await createWorkspace(other, "Not yours");
    const s2 = await beginAuthorize(owner, clientId);
    const wrongWs = await decide(s2.cookie, s2.handle, { workspace: foreignWs, decision: "approve" });
    expect(wrongWs.status).toBe(403);

    const { refresh_token, clientId: c2 } = await authorize(owner, ws);
    const refreshed = await token({ grant_type: "refresh_token", refresh_token, client_id: c2 });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(refresh_token);
    expect((await call(refreshed.body.access_token, "workspace_info", {})).result?.isError).toBeFalsy();
  });

  it("stops working immediately after revocation or member removal", async () => {
    const { owner, ws } = await setup();
    const { access_token: at } = await authorize(owner, ws, ["workspace:write"]);
    const grants = await api(owner, "GET", "/api/agent-grants");
    expect(grants.body.grants).toHaveLength(1);
    expect((await call(at, "workspace_info", {})).result?.isError).toBeFalsy();
    expect((await api(owner, "DELETE", `/api/agent-grants/${grants.body.grants[0].id}`)).status).toBe(200);
    const after = await call(at, "workspace_info", {});
    expect(after.status === 401 || after.result?.isError === true).toBe(true);

    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const { access_token: et } = await authorize(editor, ws, ["workspace:write"]);
    expect((await call(et, "workspace_info", {})).result?.isError).toBeFalsy();
    await api(owner, "DELETE", `/api/w/${ws}/members/${editor.id}`);
    const removed = await call(et, "workspace_info", {});
    expect(removed.status === 401 || removed.result?.isError === true).toBe(true);
  });

  it("rejects hostile browser origins and tokens for another workspace's objects", async () => {
    const { owner, ws } = await setup();
    const { access_token: at } = await authorize(owner, ws);
    const hostile = await mcp(at, "tools/list", {}, { Origin: "https://evil.example" });
    expect(hostile.status).toBe(403);
    const stranger = await signUp();
    const otherWs = await createWorkspace(stranger);
    const foreign = await api(stranger, "POST", `/api/w/${otherWs}/pages`, { title: "secret" });
    const r = await call(at, "read_page", { pageId: foreign.body.page.id });
    expect(r.result!.structuredContent.error.code).toBe("not_found");
  });

  it("delivers MCP edits to a live editor", async () => {
    const { owner, ws } = await setup();
    const { access_token: at } = await authorize(owner, ws, ["workspace:write"]);
    const { body } = await api(owner, "POST", `/api/w/${ws}/pages`, { title: "Live" });
    const live = client(owner, body.page.id);
    await live.provider.start();
    await until(() => live.provider.current.phase === "synced", "sync");
    const frag = live.doc.getXmlFragment(FRAGMENT);
    frag.insert(0, [jsonToY({ type: "paragraph", attrs: { id: "bhuman01" }, content: [{ type: "text", text: "human" }] })]);
    await until(() => live.provider.current.phase === "synced" && (live.provider.current.revision ?? 0) >= 1, "ack");
    const r = await call(at, "edit_blocks", { pageId: body.page.id, ops: [{ op: "insert", at: { afterBlockId: "bhuman01" }, content: { markdown: "agent line" } }] });
    expect(r.result?.isError).toBeFalsy();
    await until(() => live.text().includes("agent line"), "agent edit in live doc");
    expect(live.text().indexOf("human")).toBeLessThan(live.text().indexOf("agent line"));
    live.provider.destroy();
  });
});
