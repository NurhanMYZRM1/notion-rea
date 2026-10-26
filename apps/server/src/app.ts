import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { CLOSE } from "@workspace/core/sync";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type Auth, createAuth, testLoginEnabled } from "./auth";
import { type Actor, requireAccess, requirePageAccess } from "./domain/access";
import { download, MAX_UPLOAD_BYTES, upload } from "./domain/attachments";
import { addComment, deleteComment, listComments } from "./domain/comments";
import {
  createDatabase,
  createRecord,
  createView,
  deleteView,
  exportCsv,
  getDatabase,
  getRecord,
  importCsv,
  queryRecords,
  updateRecord,
  updateSchema,
  updateView,
} from "./domain/databases";
import { EditOp } from "./domain/doc-edits";
import { editDocument, exportMarkdown, importMarkdown, readDocument } from "./domain/documents";
import { listGrants, revokeGrant } from "./domain/grants";
import {
  acceptInvitation,
  createInvitation,
  deleteAccount,
  listInvitations,
  listMembers,
  listWorkspaces,
  removeMember,
  renameWorkspace,
  revokeInvitation,
  updateMember,
} from "./domain/members";
import {
  archivePage,
  createPage,
  createSubpage,
  deletePermanently,
  getPage,
  listChildren,
  listPinned,
  listTrash,
  movePage,
  page,
  recordVisit,
  restorePage,
  setFavorite,
  updatePage,
} from "./domain/pages";
import { search } from "./domain/search";
import { hierarchy } from "./domain/hierarchy";
import { processPageReferences } from "./domain/page-references";
import { AppError } from "./errors";
import { backupDocuments, restoreDocuments } from "./backup";
import { handleAuthorize } from "./oauth";
import { log } from "./util";

type User = { id: string; email: string; name: string; image?: string | null; emailVerified: boolean };
type HonoEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers }; Variables: { auth: Auth; user: User | null } };
type C = Context<HonoEnv>;

const idParam = z.string().regex(/^[a-z]{1,4}_[0-9A-Za-z]{8,40}$/);

function user(c: C): User {
  const u = c.get("user");
  if (!u) throw new AppError("unauthenticated", "Sign in required");
  return u;
}
const actorOf = (c: C): Actor => ({ kind: "user", userId: user(c).id });
const param = (c: C, name: string) => {
  const value = c.req.param(name);
  if (!value || !idParam.safeParse(value).success) throw new AppError("not_found", "Not found");
  return value;
};

async function body(c: C): Promise<unknown> {
  if (!c.req.header("Content-Type")?.startsWith("application/json")) throw new AppError("unsupported", "Expected application/json");
  try {
    return await c.req.json();
  } catch {
    throw new AppError("invalid_input", "Malformed JSON");
  }
}

async function optionalBody(c: C): Promise<unknown> {
  // HTTP servers can expose an empty POST as a non-null, zero-byte request stream.
  const text = await c.req.text();
  if (!text.trim()) return {};
  if (!c.req.header("Content-Type")?.startsWith("application/json")) throw new AppError("unsupported", "Expected application/json");
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("invalid_input", "Malformed JSON");
  }
}

/** Reject cross-site browser requests; native apps send no Origin. */
function sameOrigin(c: C): boolean {
  const origin = c.req.header("Origin");
  return !origin || origin === new URL(c.env.PUBLIC_URL).origin;
}

/** Accept a WebSocket only to close it with a code the client understands (status codes are invisible to browsers). */
function closeSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export function buildApp() {
  const app = new Hono<HonoEnv>();

  app.use("*", async (c, next) => {
    const auth = createAuth(c.env);
    c.set("auth", auth);
    const path = c.req.path;
    if (path.startsWith("/api/auth/")) return next();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("user", (session?.user as User | undefined) ?? null);
    await next();
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c)) throw new AppError("forbidden", "Cross-site request blocked");
    const u = c.get("user");
    if (u && c.env.API_LIMIT) {
      const { success } = await c.env.API_LIMIT.limit({ key: u.id });
      if (!success) throw new AppError("rate_limited", "Too many requests; slow down");
    }
    await next();
    c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
  });

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.status as 400);
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: "invalid_input", message: "Invalid input", details: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) } }, 400);
    }
    log("unhandled_error", { path: c.req.path, error: String(err).slice(0, 300) });
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  // ---------- auth ----------
  app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));
  app.get("/api/providers", (c) =>
    c.json({
      google: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
      apple: !!(c.env.APPLE_CLIENT_ID && c.env.APPLE_CLIENT_SECRET),
      testLogin: testLoginEnabled(c.env),
    }),
  );
  app.get("/authorize", (c) => handleAuthorize(c.req.raw, c.env, c.get("auth")));
  app.post("/authorize", (c) => handleAuthorize(c.req.raw, c.env, c.get("auth")));

  // ---------- me ----------
  app.get("/api/me", async (c) => {
    const u = user(c);
    return c.json({ user: { id: u.id, email: u.email, name: u.name, image: u.image ?? null, emailVerified: u.emailVerified }, workspaces: await listWorkspaces(c.env, u.id) });
  });
  app.delete("/api/me", async (c) => {
    await deleteAccount(c.env, user(c).id);
    return c.json({ ok: true });
  });
  app.post("/api/invitations/accept", async (c) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(await body(c));
    return c.json(await acceptInvitation(c.env, user(c), token));
  });
  app.get("/api/agent-grants", async (c) => c.json({ grants: await listGrants(c.env, user(c).id) }));
  app.delete("/api/agent-grants/:id", async (c) => {
    await revokeGrant(c.env, user(c).id, param(c, "id"));
    return c.json({ ok: true });
  });

  // ---------- workspace ----------
  const ws = (c: C) => param(c, "ws");
  app.patch("/api/w/:ws", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(100) }).parse(await body(c));
    await renameWorkspace(c.env, actorOf(c), ws(c), name);
    return c.json({ ok: true });
  });
  app.get("/api/w/:ws/pages", async (c) => {
    const parentId = c.req.query("parentId") || null;
    if (parentId && !idParam.safeParse(parentId).success) throw new AppError("invalid_input", "Bad parentId");
    return c.json(await listChildren(c.env, actorOf(c), ws(c), parentId, c.req.query("cursor") || null, Math.min(Number(c.req.query("limit") ?? 100) || 100, 200)));
  });
  app.post("/api/w/:ws/pages", async (c) => c.json({ page: await createPage(c.env, actorOf(c), ws(c), (await body(c)) as object) }, 201));
  app.get("/api/w/:ws/hierarchy", async (c) => {
    const parentId = c.req.query("parentId") || null;
    const focusId = c.req.query("focusId") || null;
    for (const id of [parentId, focusId]) if (id && !idParam.safeParse(id).success) throw new AppError("invalid_input", "Bad hierarchy page id");
    return c.json(await hierarchy(c.env, actorOf(c), ws(c), { parentId, focusId, cursor: c.req.query("cursor"), limit: Number(c.req.query("limit")) || 100 }));
  });
  app.get("/api/w/:ws/favorites", async (c) => c.json({ pages: await listPinned(c.env, actorOf(c), ws(c), "favorites") }));
  app.get("/api/w/:ws/recents", async (c) => c.json({ pages: await listPinned(c.env, actorOf(c), ws(c), "recents") }));
  app.get("/api/w/:ws/trash", async (c) => c.json({ pages: await listTrash(c.env, actorOf(c), ws(c)) }));
  app.get("/api/w/:ws/search", async (c) => c.json({ results: await search(c.env, actorOf(c), ws(c), (c.req.query("q") ?? "").slice(0, 200)) }));
  app.get("/api/w/:ws/members", async (c) => c.json({ members: await listMembers(c.env, actorOf(c), ws(c)) }));
  app.patch("/api/w/:ws/members/:userId", async (c) => {
    await updateMember(c.env, actorOf(c), ws(c), userIdParam(c), await body(c));
    return c.json({ ok: true });
  });
  app.delete("/api/w/:ws/members/:userId", async (c) => {
    await removeMember(c.env, actorOf(c), ws(c), userIdParam(c));
    return c.json({ ok: true });
  });
  app.get("/api/w/:ws/invitations", async (c) => c.json({ invitations: await listInvitations(c.env, actorOf(c), ws(c)) }));
  app.post("/api/w/:ws/invitations", async (c) => c.json(await createInvitation(c.env, actorOf(c), ws(c), await body(c)), 201));
  app.delete("/api/w/:ws/invitations/:id", async (c) => {
    await revokeInvitation(c.env, actorOf(c), ws(c), param(c, "id"));
    return c.json({ ok: true });
  });
  app.post("/api/w/:ws/databases", async (c) => c.json({ database: await createDatabase(c.env, actorOf(c), ws(c), await body(c)) }, 201));
  app.post("/api/w/:ws/import/markdown", async (c) => {
    const input = z.object({ markdown: z.string().max(2_000_000), parentId: idParam.nullable().default(null), title: z.string().max(500).optional() }).parse(await body(c));
    return c.json(await importMarkdown(c.env, actorOf(c), ws(c), input), 201);
  });
  app.post("/api/w/:ws/import/csv", async (c) => {
    const input = z.object({ csv: z.string().max(5_000_000), parentId: idParam.nullable().default(null), title: z.string().min(1).max(500) }).parse(await body(c));
    return c.json(await importCsv(c.env, actorOf(c), ws(c), input.csv, { title: input.title, parentId: input.parentId }), 201);
  });

  // ---------- pages ----------
  const pid = (c: C) => param(c, "id");
  app.get("/api/pages/:id", async (c) => c.json({ page: await getPage(c.env, actorOf(c), pid(c)) }));
  app.post("/api/pages/:id/subpages", async (c) => c.json(await createSubpage(c.env, actorOf(c), pid(c), await body(c)), 201));
  app.patch("/api/pages/:id", async (c) => c.json({ page: await updatePage(c.env, actorOf(c), pid(c), await body(c)) }));
  app.post("/api/pages/:id/move", async (c) => c.json({ page: await movePage(c.env, actorOf(c), pid(c), await body(c)) }));
  app.post("/api/pages/:id/archive", async (c) => c.json({ page: await archivePage(c.env, actorOf(c), pid(c), await optionalBody(c)) }));
  app.post("/api/pages/:id/restore", async (c) => c.json({ page: await restorePage(c.env, actorOf(c), pid(c)) }));
  app.delete("/api/pages/:id", async (c) => c.json(await deletePermanently(c.env, actorOf(c), pid(c))));
  app.put("/api/pages/:id/favorite", async (c) => {
    const { favorite } = z.object({ favorite: z.boolean() }).parse(await body(c));
    await setFavorite(c.env, actorOf(c), pid(c), favorite);
    return c.json({ ok: true });
  });
  app.post("/api/pages/:id/visit", async (c) => {
    await recordVisit(c.env, actorOf(c), pid(c));
    return c.json({ ok: true });
  });
  app.get("/api/pages/:id/document", async (c) => c.json(await readDocument(c.env, actorOf(c), pid(c))));
  app.post("/api/pages/:id/edit", async (c) => {
    const input = z.object({ expectedRevision: z.number().int().nonnegative().nullable().default(null), ops: z.array(EditOp).min(1).max(50) }).parse(await body(c));
    const { revision, insertedIds, warnings, changed } = await editDocument(c.env, actorOf(c), pid(c), input.ops, input.expectedRevision);
    return c.json({ revision, insertedIds, warnings, changed });
  });
  app.get("/api/pages/:id/export.md", async (c) => {
    const result = await exportMarkdown(c.env, actorOf(c), pid(c));
    if (c.req.query("format") === "json") return c.json(result);
    return new Response(result.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": "attachment; filename=page.md", "Cache-Control": "no-store" } });
  });
  app.get("/api/pages/:id/comments", async (c) => {
    const before = c.req.query("before");
    return c.json({ comments: await listComments(c.env, actorOf(c), pid(c), before ? Number(before) : null) });
  });
  app.post("/api/pages/:id/comments", async (c) => c.json({ comment: await addComment(c.env, actorOf(c), pid(c), await body(c)) }, 201));
  app.delete("/api/pages/:id/comments/:cid", async (c) => {
    await deleteComment(c.env, actorOf(c), pid(c), param(c, "cid"));
    return c.json({ ok: true });
  });
  app.post("/api/pages/:id/attachments", async (c) => {
    const size = Number(c.req.header("Content-Length") ?? 0);
    if (!size || size > MAX_UPLOAD_BYTES) throw new AppError("too_large", `Files must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const rawName = c.req.header("X-File-Name") ?? "file";
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      /* not percent-encoded: keep as sent (sanitized in upload) */
    }
    const body = c.req.raw.body;
    if (!body) throw new AppError("invalid_input", "Empty upload");
    // R2 needs a known length; FixedLengthStream enforces that the body matches Content-Length.
    const fixed = new FixedLengthStream(size);
    void body.pipeTo(fixed.writable).catch(() => {});
    return c.json(await upload(c.env, actorOf(c), pid(c), { name, type: c.req.header("Content-Type") ?? "", size, body: fixed.readable }), 201);
  });
  app.get("/api/attachments/:id", async (c) => download(c.env, actorOf(c), param(c, "id"), c.req.header("Range") ?? null));

  // ---------- databases ----------
  const did = (c: C) => param(c, "id");
  app.get("/api/databases/:id", async (c) => c.json({ database: await getDatabase(c.env, actorOf(c), did(c)) }));
  app.put("/api/databases/:id/schema", async (c) => c.json({ database: await updateSchema(c.env, actorOf(c), did(c), await body(c)) }));
  app.post("/api/databases/:id/views", async (c) => c.json({ view: await createView(c.env, actorOf(c), did(c), await body(c)) }, 201));
  app.patch("/api/databases/:id/views/:vid", async (c) => c.json({ view: await updateView(c.env, actorOf(c), did(c), param(c, "vid"), await body(c)) }));
  app.delete("/api/databases/:id/views/:vid", async (c) => {
    await deleteView(c.env, actorOf(c), did(c), param(c, "vid"));
    return c.json({ ok: true });
  });
  app.post("/api/databases/:id/query", async (c) => c.json(await queryRecords(c.env, actorOf(c), did(c), await body(c))));
  app.post("/api/databases/:id/records", async (c) => c.json({ record: await createRecord(c.env, actorOf(c), did(c), await body(c)) }, 201));
  app.get("/api/databases/:id/export.csv", async (c) =>
    new Response(await exportCsv(c.env, actorOf(c), did(c)), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=database.csv", "Cache-Control": "no-store" } }),
  );
  app.get("/api/records/:id", async (c) => c.json({ record: await getRecord(c.env, actorOf(c), param(c, "id")) }));
  app.patch("/api/records/:id", async (c) => c.json({ record: await updateRecord(c.env, actorOf(c), param(c, "id"), await body(c)) }));

  // ---------- operator (backup/restore drills); disabled unless ADMIN_TOKEN is set ----------
  app.post("/api/admin/backup", async (c) => {
    await requireAdmin(c);
    return c.json(await backupDocuments(c.env, 200));
  });
  app.post("/api/admin/restore", async (c) => {
    await requireAdmin(c);
    const { cursor } = z.object({ cursor: z.string().max(100).nullable().default(null) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await restoreDocuments(c.env, cursor, 200));
  });

  app.all("/api/*", () => {
    throw new AppError("not_found", "No such endpoint");
  });

  // ---------- realtime ----------
  app.get("/sync/:id", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
    if (!sameOrigin(c)) return closeSocket(CLOSE.forbidden, "origin");
    const u = c.get("user");
    if (!u) return closeSocket(CLOSE.unauthenticated, "sign in");
    const pageId = c.req.param("id");
    if (!idParam.safeParse(pageId).success) return closeSocket(CLOSE.notFound, "not found");
    let access;
    try {
      access = await requirePageAccess(c.env, { kind: "user", userId: u.id }, pageId, "read");
    } catch (err) {
      return closeSocket(err instanceof AppError && err.code === "not_found" ? CLOSE.notFound : CLOSE.forbidden, "no access");
    }
    await processPageReferences(c.env, { workspaceId: access.workspaceId, parentIds: [pageId] });
    await c.env.DB.prepare(
      "INSERT INTO doc_sessions (page_id, user_id, workspace_id, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(page_id, user_id) DO UPDATE SET connected_at = excluded.connected_at",
    )
      .bind(pageId, u.id, access.workspaceId, Date.now())
      .run();
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-User-Id", u.id);
    headers.set("X-Workspace-Id", access.workspaceId);
    headers.set("X-Role", access.role);
    headers.set("X-Page-Id", pageId);
    headers.set("X-Page-State", access.page.state);
    headers.set("X-Document-Schema-Version", c.req.query("schema") === "2" ? "2" : "1");
    return page(c.env, pageId).fetch(new Request(c.req.url, { headers }));
  });

  app.get("/events/:ws", async (c) => {
    if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
    if (!sameOrigin(c)) return closeSocket(CLOSE.forbidden, "origin");
    const u = c.get("user");
    if (!u) return closeSocket(CLOSE.unauthenticated, "sign in");
    const workspaceId = c.req.param("ws");
    try {
      if (!idParam.safeParse(workspaceId).success) throw new AppError("not_found", "x");
      await requireAccess(c.env, { kind: "user", userId: u.id }, workspaceId, "read");
    } catch {
      return closeSocket(CLOSE.forbidden, "no access");
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set("X-User-Id", u.id);
    return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(workspaceId)).fetch(new Request(c.req.url, { headers }));
  });

  return app;
}

async function requireAdmin(c: C): Promise<void> {
  const expected = c.env.ADMIN_TOKEN;
  const given = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
  if (!expected || expected.length < 24 || given.length !== expected.length) throw new AppError("not_found", "No such endpoint");
  const enc = new TextEncoder();
  // Constant-time compare (timingSafeEqual is a workerd extension of SubtleCrypto).
  if (!crypto.subtle.timingSafeEqual(enc.encode(given), enc.encode(expected))) throw new AppError("not_found", "No such endpoint");
}

function userIdParam(c: C): string {
  const value = c.req.param("userId");
  if (!value || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw new AppError("not_found", "Member not found");
  return value;
}
