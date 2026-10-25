import { SyncProvider, type SyncState } from "@workspace/core/sync";
import { env, SELF } from "cloudflare:test";
import * as Y from "yjs";

export const BASE = "http://localhost:5173";

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

let n = 0;
export async function signUp(email = `user${++n}-${crypto.randomUUID().slice(0, 6)}@example.com`): Promise<TestUser> {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: email.split("@")[0] }),
  });
  if (!res.ok) throw new Error(`sign-up failed ${res.status}: ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const body = (await res.json()) as { user: { id: string } };
  return { id: body.user.id, email, cookie };
}

export async function createWorkspace(owner: TestUser, name = "Team"): Promise<string> {
  const id = `ws_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").bind(id, name, owner.id, Date.now()),
    env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, owner.id, Date.now()),
  ]);
  return id;
}

export async function addMember(workspaceId: string, user: TestUser, role: "owner" | "editor" | "viewer"): Promise<void> {
  await env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(workspaceId, user.id, role, Date.now()).run();
}

export async function api<T = any>(user: TestUser | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { Origin: BASE };
  if (user) headers.Cookie = user.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T };
}

export async function openSocket(user: TestUser, pageId: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${BASE}/sync/${pageId}`, { headers: { Upgrade: "websocket", Cookie: user.cookie, Origin: BASE } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no websocket (${res.status})`);
  ws.accept();
  return ws;
}

/** A client like the web app: Y.Doc + SyncProvider (no local store unless given). */
export function client(user: TestUser, pageId: string, store: ConstructorParameters<typeof SyncProvider>[0]["store"] = null) {
  const doc = new Y.Doc();
  const states: SyncState[] = [];
  const provider = new SyncProvider({ doc, store, connect: () => openSocket(user, pageId), onState: (s) => states.push(s), batchMs: 5 });
  return { doc, provider, states, text: () => doc.getXmlFragment("default").toString() };
}

export async function until(check: () => boolean | Promise<boolean>, label = "condition", timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** In-memory DocStore for offline tests. */
export function memoryStore() {
  const data = { updates: [] as Uint8Array[], localCounter: 0, syncedCounter: 0 };
  return {
    data,
    async load() {
      return { updates: [...data.updates], localCounter: data.localCounter, syncedCounter: data.syncedCounter };
    },
    async append(update: Uint8Array, counter: number | null) {
      data.updates.push(update);
      if (counter !== null) data.localCounter = Math.max(data.localCounter, counter);
    },
    async markSynced(counter: number) {
      data.syncedCounter = Math.max(data.syncedCounter, counter);
    },
  };
}

// ---------- shared fixtures for the wider suites ----------

/** Open a WebSocket on any realtime path and resolve with its close code (or "open" if it stays open). */
export async function socketOutcome(user: TestUser, path: string, waitMs = 1000): Promise<{ code: number | "open"; messages: unknown[]; ws: WebSocket | null }> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket", Cookie: user.cookie, Origin: BASE } });
  const ws = res.webSocket;
  if (!ws) return { code: res.status, messages: [], ws: null };
  const messages: unknown[] = [];
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  ws.addEventListener("message", (e) => {
    messages.push(e.data);
  });
  ws.accept();
  const code = await Promise.race([closed, new Promise<"open">((r) => setTimeout(() => r("open"), waitMs))]);
  return { code, messages, ws };
}

export async function uploadFile(
  user: TestUser,
  pageId: string,
  body: BodyInit,
  type = "image/png",
  name = "pic.png",
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const res = await SELF.fetch(`${BASE}/api/pages/${pageId}/attachments`, {
    method: "POST",
    headers: {
      Origin: BASE,
      Cookie: user.cookie,
      "Content-Type": type,
      "X-File-Name": encodeURIComponent(name),
      ...(bytes instanceof Uint8Array ? { "Content-Length": String(bytes.byteLength) } : {}),
      ...extra,
    },
    body: bytes,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed };
}

export async function newPage(user: TestUser, ws: string, input: Record<string, unknown> = {}): Promise<any> {
  const res = await api(user, "POST", `/api/w/${ws}/pages`, { title: "Page", ...input });
  if (res.status !== 201) throw new Error(`create page failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.page;
}

export async function newDatabase(user: TestUser, ws: string, input: Record<string, unknown> = {}): Promise<any> {
  const res = await api(user, "POST", `/api/w/${ws}/databases`, { title: "DB", ...input });
  if (res.status !== 201) throw new Error(`create database failed ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.database;
}
