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
