import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, api, BASE, createWorkspace, newPage, signUp, uploadFile } from "./helpers";

async function setup() {
  const owner = await signUp();
  const ws = await createWorkspace(owner);
  const page = await newPage(owner, ws);
  return { owner, ws, page };
}
const get = (cookie: string, src: string, headers: Record<string, string> = {}) => SELF.fetch(`${BASE}${src}`, { headers: { Cookie: cookie, ...headers } });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

describe("attachments", () => {
  it("round-trips bytes with safe headers", async () => {
    const { owner, page } = await setup();
    const up = await uploadFile(owner, page.id, PNG, "image/png", "Résumé photo (1).png");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "Résumé photo (1).png", mimeType: "image/png", size: PNG.byteLength });
    const res = await get(owner.cookie, up.body.src);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Content-Disposition")).toBe(`inline; filename*=UTF-8''${encodeURIComponent("Résumé photo (1).png")}`);
    expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    const key = (await env.DB.prepare("SELECT r2_key FROM attachments WHERE id = ?").bind(up.body.id).first<{ r2_key: string }>())!.r2_key;
    expect(key).toBe(`ws/${page.workspaceId}/${up.body.id}`);

    const text = await uploadFile(owner, page.id, "plain words", "text/plain; charset=utf-8", "../../etc/passwd\r\nX-Evil: 1");
    expect(text.status).toBe(201);
    expect(text.body.name).toBe(".._.._etc_passwd__X-Evil: 1");
    const t = await get(owner.cookie, text.body.src);
    expect(t.headers.get("Content-Type")).toBe("text/plain");
    expect(t.headers.get("Content-Disposition")).toMatch(/^attachment; filename\*=UTF-8''/);
    expect(t.headers.get("X-Evil")).toBeNull();
    expect(await t.text()).toBe("plain words");

    const range = await get(owner.cookie, up.body.src, { Range: "bytes=8-11" });
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(PNG.slice(8, 12));
    // A filename that is not percent-encoded is kept as sent instead of failing.
    expect((await uploadFile(owner, page.id, PNG, "image/png", "x", { "X-File-Name": "%E0%A4%A" })).body.name).toBe("%E0%A4%A");
  });

  it("enforces size limits, including a Content-Length that lies", async () => {
    const { owner, page } = await setup();
    const big = await uploadFile(owner, page.id, new Uint8Array(10), "image/png", "a.png", { "Content-Length": String(25 * 1024 * 1024 + 1) });
    expect(big.status).toBe(413);
    const stream = (n: number) => new Blob([new Uint8Array(n)]).stream();
    const post = (len: string, body: BodyInit) =>
      SELF.fetch(`${BASE}/api/pages/${page.id}/attachments`, { method: "POST", headers: { Origin: BASE, Cookie: owner.cookie, "Content-Type": "image/png", "Content-Length": len }, body });
    expect((await post("100", stream(10))).status).toBe(400); // shorter than declared
    expect((await post("5", stream(100))).status).toBe(400); // longer than declared
    expect((await post("0", new Uint8Array(0))).status).toBe(413);
    expect((await env.FILES.list({ prefix: `ws/${page.workspaceId}/` })).objects).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE page_id = ?").bind(page.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses active content types", async () => {
    const { owner, page } = await setup();
    for (const type of ["text/html", "image/svg+xml", "application/javascript", "application/xhtml+xml", "", "IMAGE/SVG+XML"]) {
      expect((await uploadFile(owner, page.id, "<svg onload=alert(1)>", type, "x")).status, type).toBe(415);
    }
    expect((await uploadFile(owner, page.id, PNG, "IMAGE/PNG", "upper.png")).status).toBe(201);
  });

  it("respects membership and page state", async () => {
    const { owner, ws, page } = await setup();
    const outsider = await signUp();
    const viewer = await signUp();
    await addMember(ws, viewer, "viewer");
    const up = await uploadFile(owner, page.id, PNG);
    expect((await uploadFile(outsider, page.id, PNG)).status).toBe(404);
    expect((await get(outsider.cookie, up.body.src)).status).toBe(404);
    expect((await uploadFile(viewer, page.id, PNG)).status).toBe(403);
    expect((await get(viewer.cookie, up.body.src)).status).toBe(200);
    expect((await get("", up.body.src)).status).toBe(401);
    expect((await get(owner.cookie, "/api/attachments/at_doesnotexist000000")).status).toBe(404);

    await api(owner, "POST", `/api/pages/${page.id}/archive`);
    expect((await uploadFile(owner, page.id, PNG)).status).toBe(409);
    expect((await get(owner.cookie, up.body.src)).status).toBe(200); // still readable from the trash
    await api(owner, "DELETE", `/api/pages/${page.id}`);
    expect((await get(owner.cookie, up.body.src)).status).toBe(404);
  });
});
