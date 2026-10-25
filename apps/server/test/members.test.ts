import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, api, client, createWorkspace, newPage, signUp, socketOutcome, until } from "./helpers";

async function sha256Hex(input: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function setup() {
  const owner = await signUp();
  const ws = await createWorkspace(owner);
  return { owner, ws };
}

async function invite(owner: Awaited<ReturnType<typeof signUp>>, ws: string, email: string, role = "editor") {
  const res = await api(owner, "POST", `/api/w/${ws}/invitations`, { email, role });
  expect(res.status).toBe(201);
  return { id: res.body.invitation.id as string, token: (res.body.url as string).split("#")[1]!, url: res.body.url as string };
}

const accept = (user: Awaited<ReturnType<typeof signUp>>, token: string) => api(user, "POST", "/api/invitations/accept", { token });

describe("invitations", () => {
  it("stores only a hash of the token and is single-use per person", async () => {
    const { owner, ws } = await setup();
    const guest = await signUp();
    const inv = await invite(owner, ws, guest.email);
    expect(inv.url).toMatch(/^http:\/\/localhost:5173\/invite#/);
    const row = await env.DB.prepare("SELECT * FROM invitations WHERE id = ?").bind(inv.id).first();
    expect(row!.token_hash).toBe(await sha256Hex(inv.token));
    expect(JSON.stringify(row)).not.toContain(inv.token);

    const first = await accept(guest, inv.token);
    expect(first).toEqual({ status: 200, body: { workspaceId: ws, role: "editor" } });
    // Same person again: idempotent.
    expect(await accept(guest, inv.token)).toEqual(first);
    // Someone else with the same link: gone.
    const other = await signUp();
    expect((await accept(other, inv.token)).status).toBe(410);
    const members = await api(owner, "GET", `/api/w/${ws}/members`);
    expect(members.body.members.map((m: { userId: string }) => m.userId).sort()).toEqual([owner.id, guest.id].sort());
    const listed = await api(owner, "GET", `/api/w/${ws}/invitations`);
    expect(listed.body.invitations[0].status).toBe("accepted");
  });

  it("refuses expired, revoked, unknown and malformed links", async () => {
    const { owner, ws } = await setup();
    const guest = await signUp();
    const expired = await invite(owner, ws, guest.email);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect((await accept(guest, expired.token)).status).toBe(410);

    const revoked = await invite(owner, ws, guest.email);
    expect((await api(owner, "DELETE", `/api/w/${ws}/invitations/${revoked.id}`)).status).toBe(200);
    expect((await accept(guest, revoked.token)).status).toBe(410);

    expect((await accept(guest, "x".repeat(43))).status).toBe(404);
    expect((await accept(guest, "short")).status).toBe(400);
    expect((await api(guest, "POST", "/api/invitations/accept", { token: 5 })).status).toBe(400);
    expect((await api(null, "POST", "/api/invitations/accept", { token: expired.token })).status).toBe(401);
    expect((await api(owner, "GET", `/api/w/${ws}/invitations`)).body.invitations.map((i: { status: string }) => i.status).sort()).toEqual(["expired", "revoked"]);
    expect((await api(guest, "GET", "/api/me")).body.workspaces).toEqual([]);
  });

  it("requires the invited, verified email and masks it in the error", async () => {
    const { owner, ws } = await setup();
    const invitedEmail = `invited-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const inv = await invite(owner, ws, invitedEmail);
    const wrong = await signUp();
    const res = await accept(wrong, inv.token);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("in***@example.com");
    expect(JSON.stringify(res.body)).not.toContain(invitedEmail);

    const unverified = await signUp(invitedEmail);
    await env.DB.prepare('UPDATE "user" SET emailVerified = 0 WHERE id = ?').bind(unverified.id).run();
    expect((await accept(unverified, inv.token)).status).toBe(403);
    await env.DB.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(unverified.id).run();
    expect((await accept(unverified, inv.token)).status).toBe(200);
  });

  it("never downgrades an owner who accepts a lesser invitation", async () => {
    const { owner, ws } = await setup();
    const coOwner = await signUp();
    await addMember(ws, coOwner, "owner");
    const inv = await invite(owner, ws, coOwner.email, "editor");
    const res = await accept(coOwner, inv.token);
    expect(res.status).toBe(200);
    const role = await env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(ws, coOwner.id).first<{ role: string }>();
    expect(role!.role).toBe("owner");
    expect(res.body.role).toBe("owner");
  });
});

describe("membership", () => {
  it("keeps at least one owner", async () => {
    const { owner, ws } = await setup();
    expect((await api(owner, "PATCH", `/api/w/${ws}/members/${owner.id}`, { role: "editor" })).status).toBe(409);
    expect((await api(owner, "DELETE", `/api/w/${ws}/members/${owner.id}`)).status).toBe(409);
    const second = await signUp();
    await addMember(ws, second, "owner");
    expect((await api(owner, "PATCH", `/api/w/${ws}/members/${second.id}`, { role: "editor" })).status).toBe(200);
    expect((await api(owner, "PATCH", `/api/w/${ws}/members/${owner.id}`, { role: "viewer" })).status).toBe(409);
    expect((await api(owner, "PATCH", `/api/w/${ws}/members/${second.id}`, { role: "owner" })).status).toBe(200);
    expect((await api(owner, "DELETE", `/api/w/${ws}/members/${owner.id}`)).status).toBe(200);
    expect((await api(second, "DELETE", `/api/w/${ws}/members/${second.id}`)).status).toBe(409);
    expect((await api(second, "PATCH", `/api/w/${ws}/members/nobody-here-123`, { role: "viewer" })).status).toBe(404);
  });

  it("lets non-owners leave but not remove others", async () => {
    const { owner, ws } = await setup();
    const [editor, viewer] = [await signUp(), await signUp()];
    await addMember(ws, editor, "editor");
    await addMember(ws, viewer, "viewer");
    expect((await api(editor, "DELETE", `/api/w/${ws}/members/${viewer.id}`)).status).toBe(403);
    expect((await api(viewer, "DELETE", `/api/w/${ws}/members/${viewer.id}`)).status).toBe(200);
    expect((await api(viewer, "GET", `/api/w/${ws}/pages`)).status).toBe(404);
    expect((await api(owner, "GET", `/api/w/${ws}/members`)).body.members).toHaveLength(2);
  });

  it("removal revokes grants, closes document and event sockets, and blocks later calls", async () => {
    const { owner, ws } = await setup();
    const editor = await signUp();
    await addMember(ws, editor, "editor");
    const page = await newPage(owner, ws);
    const grantId = `ag_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
    await env.DB.prepare("INSERT INTO agent_grants (id, workspace_id, user_id, client_id, client_name, scopes, created_at) VALUES (?, ?, ?, 'c', 'Client', 'workspace:read workspace:write', ?)")
      .bind(grantId, ws, editor.id, Date.now())
      .run();
    const doc = client(editor, page.id);
    await doc.provider.start();
    await until(() => doc.provider.current.phase === "synced", "sync");
    const events = await socketOutcome(editor, `/events/${ws}`, 50);
    expect(events.code).toBe("open");
    const closed = new Promise<number>((r) => events.ws!.addEventListener("close", (e) => r(e.code)));

    expect((await api(owner, "DELETE", `/api/w/${ws}/members/${editor.id}`)).status).toBe(200);
    await until(() => doc.provider.current.failure === "revoked", "doc socket revoked");
    expect(await closed).toBe(4403);
    const grant = await env.DB.prepare("SELECT revoked_at FROM agent_grants WHERE id = ?").bind(grantId).first<{ revoked_at: number | null }>();
    expect(grant!.revoked_at).toBeGreaterThan(0);
    expect((await api(editor, "GET", "/api/agent-grants")).body.grants).toEqual([]);
    expect((await api(editor, "GET", `/api/pages/${page.id}`)).status).toBe(404);
    expect((await api(editor, "POST", `/api/w/${ws}/pages`, { title: "after" })).status).toBe(404);
    expect((await socketOutcome(editor, `/sync/${page.id}`)).code).toBe(4404);
    expect((await socketOutcome(editor, `/events/${ws}`)).code).toBe(4403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM doc_sessions WHERE user_id = ?").bind(editor.id).first<{ n: number }>()).toEqual({ n: 0 });
    doc.provider.destroy();
  });

  it("deletes an account unless it is the sole owner somewhere", async () => {
    const { owner, ws } = await setup();
    const member = await signUp();
    await addMember(ws, member, "editor");
    const own = await createWorkspace(member, "Mine");

    const refused = await api(member, "DELETE", "/api/me");
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual({ workspaceId: own });
    expect((await api(member, "GET", "/api/me")).status).toBe(200);

    await addMember(own, owner, "owner");
    const res = await api(member, "DELETE", "/api/me");
    expect(res.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(member.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM "session" WHERE userId = ?').bind(member.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM members WHERE user_id = ?").bind(member.id).first()).toBeNull();
    expect((await api(member, "GET", "/api/me")).status).toBe(401);
    expect((await api(member, "GET", `/api/w/${ws}/pages`)).status).toBe(401);
    // The other owner keeps both workspaces.
    expect((await api(owner, "GET", "/api/me")).body.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([ws, own].sort());
  });
});
