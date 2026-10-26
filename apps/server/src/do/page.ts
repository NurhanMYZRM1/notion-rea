import { blockId, findBlock, FRAGMENT, plainText, type PMNode, type Role, jsonToY, yToJSON } from "@workspace/core";
import {
  awarenessClocks,
  CLOSE,
  type Control,
  encodeAck,
  encodeAwarenessRemoval,
  encodeControl,
  MSG_AWARENESS,
  MSG_SYNC,
  PROTOCOL_VERSION,
} from "@workspace/core/sync";
import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { AppError } from "../errors";
import { type EditOp, planEdits } from "../domain/doc-edits";
import { log } from "../util";

interface SocketMeta {
  userId: string;
  workspaceId: string;
  role: Role;
  schemaVersion: number;
  checkedAt: number;
  /** Awareness client ids/clocks last announced on this socket (cleared on close). */
  clients: { id: number; clock: number }[];
}

const RECHECK_MS = 5_000; // permission re-validation interval for writes on an open socket
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const COMPACT_AFTER_UPDATES = 500;
const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_CHUNK = 1024 * 1024; // DO SQLite values are capped at 2 MB
const PROJECTION_DELAY_MS = 2_000;

/**
 * Canonical body of one page: a Yjs document persisted as an append-only update log plus chunked
 * snapshots in this object's SQLite storage. Every accepted update is committed before it is
 * acknowledged or broadcast (the output gate holds outgoing messages until storage confirms).
 */
export class PageDocument extends DurableObject<Env> {
  private doc: Y.Doc | null = null;
  private sql: SqlStorage;
  private alarmSet = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createTables();
  }

  private createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value);
    `);
  }

  // ---------- storage ----------

  private meta<T extends string | number>(key: string): T | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return (row?.value as T | undefined) ?? null;
  }
  private setMeta(key: string, value: string | number): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  get revision(): number {
    return Number(this.meta("revision") ?? 0);
  }

  private load(): Y.Doc {
    if (this.doc) return this.doc;
    const doc = new Y.Doc({ gc: true });
    const chunks = this.sql.exec("SELECT data FROM snapshot ORDER BY idx").toArray().map((r) => new Uint8Array(r.data as ArrayBuffer));
    if (chunks.length) Y.applyUpdate(doc, concat(chunks));
    for (const row of this.sql.exec("SELECT data FROM updates ORDER BY seq")) Y.applyUpdate(doc, new Uint8Array(row.data as ArrayBuffer));
    this.doc = doc;
    return doc;
  }

  /**
   * Apply an update and durably record its effect. Returns the new revision, or null if the update
   * changed nothing (duplicates and reordered re-sends are idempotent in Yjs).
   */
  private commit(update: Uint8Array, origin: string): { revision: number; effective: Uint8Array } | null {
    const doc = this.load();
    let effective: Uint8Array | null = null;
    const capture = (u: Uint8Array) => (effective = u);
    doc.on("update", capture);
    try {
      Y.applyUpdate(doc, update, origin);
    } finally {
      doc.off("update", capture);
    }
    // Updates whose dependencies are missing are held by Yjs as pending; persist them raw so a restart keeps them.
    const pending = !effective && (doc.store.pendingStructs || doc.store.pendingDs);
    const toStore: Uint8Array | null = effective ?? (pending ? update : null);
    if (!toStore) return null;
    const revision = this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO updates (data) VALUES (?)", toStore);
      const next = this.revision + 1;
      this.setMeta("revision", next);
      this.setMeta("projection_due", next);
      return next;
    });
    this.maybeCompact();
    this.scheduleProjection();
    return { revision, effective: effective ?? new Uint8Array() };
  }

  private maybeCompact(): void {
    const stats = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes, MAX(seq) AS max FROM updates").one();
    if (Number(stats.n) < COMPACT_AFTER_UPDATES && Number(stats.bytes) < COMPACT_AFTER_BYTES) return;
    const state = Y.encodeStateAsUpdate(this.load());
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM snapshot");
      for (let i = 0, idx = 0; i < state.length; i += SNAPSHOT_CHUNK, idx++) {
        this.sql.exec("INSERT INTO snapshot (idx, data) VALUES (?, ?)", idx, state.subarray(i, i + SNAPSHOT_CHUNK));
      }
      this.sql.exec("DELETE FROM updates WHERE seq <= ?", stats.max);
    });
  }

  private scheduleProjection(): void {
    if (this.alarmSet) return;
    this.alarmSet = true;
    void this.ctx.storage.getAlarm().then((at) => (at == null ? this.ctx.storage.setAlarm(Date.now() + PROJECTION_DELAY_MS) : undefined));
  }

  /** Search projection outbox: retried until D1 accepts it; stale revisions are rejected by D1. */
  async alarm(): Promise<void> {
    this.alarmSet = false;
    const pageId = this.meta<string>("page_id");
    const due = Number(this.meta("projection_due") ?? 0);
    const done = Number(this.meta("projected_revision") ?? 0);
    if (!pageId || due <= done || this.meta("deleted")) return;
    const body = plainText(yToJSON(this.load().getXmlFragment(FRAGMENT))).slice(0, 500_000);
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO search_docs (page_id, workspace_id, title, body, revision)
             SELECT id, workspace_id, title, ?, ? FROM pages WHERE id = ? AND state != 'deleted'
           ON CONFLICT(page_id) DO UPDATE SET body = excluded.body, revision = excluded.revision
             WHERE excluded.revision > search_docs.revision`,
        ).bind(body, due, pageId),
        this.env.DB.prepare("UPDATE pages SET updated_at = ? WHERE id = ? AND state != 'deleted'").bind(Date.now(), pageId),
      ]);
      this.setMeta("projected_revision", due);
      this.setMeta("projection_attempts", 0);
    } catch (err) {
      const attempts = Number(this.meta("projection_attempts") ?? 0) + 1;
      this.setMeta("projection_attempts", attempts);
      log("projection_failed", { pageId, attempts, error: String(err).slice(0, 200) });
      await this.ctx.storage.setAlarm(Date.now() + Math.min(300_000, 1000 * 2 ** attempts));
      this.alarmSet = true;
      return;
    }
    if (Number(this.meta("projection_due") ?? 0) > due) this.scheduleProjection();
  }

  // ---------- WebSocket sessions ----------

  async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get("X-User-Id");
    const workspaceId = request.headers.get("X-Workspace-Id");
    const role = request.headers.get("X-Role") as Role | null;
    const pageId = request.headers.get("X-Page-Id");
    const pageState = request.headers.get("X-Page-State") === "archived" ? "archived" : "active";
    if (!userId || !workspaceId || !role || !pageId || request.headers.get("Upgrade") !== "websocket") {
      return new Response("Bad request", { status: 400 });
    }
    this.remember(pageId, workspaceId, pageState);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [userId]);
    const schemaVersion = Number(request.headers.get("X-Document-Schema-Version") ?? 1);
    const meta: SocketMeta = { userId, workspaceId, role, schemaVersion, checkedAt: Date.now(), clients: [] };
    server.serializeAttachment(meta);

    const doc = this.load();
    if (schemaVersion < 2 && owningReferences(doc).length) {
      this.endSocket(server, { type: "upgrade-required", requiredSchemaVersion: 2 }, CLOSE.upgradeRequired);
      return new Response(null, { status: 101, webSocket: client });
    }
    server.send(encodeControl({ type: "hello", revision: this.revision, role, state: pageState, v: PROTOCOL_VERSION }));
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, doc);
    server.send(encoding.toUint8Array(e));
    return new Response(null, { status: 101, webSocket: client });
  }

  private remember(pageId: string, workspaceId: string, state: string): void {
    if (this.meta("page_id") !== pageId) this.setMeta("page_id", pageId);
    if (this.meta("workspace_id") !== workspaceId) this.setMeta("workspace_id", workspaceId);
    this.setMeta("state", state);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" || message.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(CLOSE.tooLarge, "message too large");
      return;
    }
    const data = new Uint8Array(message);
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === MSG_AWARENESS) return this.onAwareness(ws, decoding.readVarUint8Array(d));
    if (type !== MSG_SYNC) return;

    const kind = decoding.readVarUint(d);
    if (kind === syncProtocol.messageYjsSyncStep1) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep2(e, this.load(), decoding.readVarUint8Array(d));
      ws.send(encoding.toUint8Array(e));
      return;
    }
    if (kind !== syncProtocol.messageYjsSyncStep2 && kind !== syncProtocol.messageYjsUpdate) return;
    const update = decoding.readVarUint8Array(d);

    // Handshake step2s usually carry only already-known content (Yjs always sends the full delete set).
    if (!wouldChange(this.load(), update)) {
      ws.send(encodeAck(this.revision));
      return;
    }
    const meta = await this.revalidate(ws);
    if (!meta) return;
    const state = this.meta("state");
    if (meta.role === "viewer" || state === "archived") {
      ws.send(encodeControl({ type: "read-only", reason: meta.role === "viewer" ? "viewer" : "archived" }));
      return; // not applied, not acknowledged: the client keeps it as an unsynchronized draft
    }
    // Never reject a client update over subpage links: a stale offline reorder would then fail on every
    // reconnect. Commit it, and if links changed, rebuild them from D1 (the authority).
    const links = owningReferences(this.load()).join();
    const result = this.commit(update, "ws");
    ws.send(encodeAck(result?.revision ?? this.revision));
    if (result && result.effective.length) this.broadcastUpdate(result.effective, ws);
    if (result && owningReferences(this.load()).join() !== links) await this.repairLinks();
  }

  private async repairLinks(): Promise<void> {
    const pageId = this.meta<string>("page_id");
    const workspaceId = this.meta<string>("workspace_id");
    if (!pageId || !workspaceId) return;
    try {
      await this.reconcileChildPages(pageId, workspaceId);
    } catch (err) {
      // Leave it to the outbox: the next read, edit or minute cron reconciles this parent.
      log("link_repair_deferred", { pageId, error: String(err).slice(0, 200) });
      await this.env.DB.prepare(
        `INSERT INTO page_reference_outbox(parent_id, workspace_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(parent_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
      ).bind(pageId, workspaceId, Date.now()).run().catch(() => {});
    }
  }

  /** Re-read membership/page state at most every RECHECK_MS; close the socket if access is gone. */
  private async revalidate(ws: WebSocket): Promise<SocketMeta | null> {
    const meta = ws.deserializeAttachment() as SocketMeta;
    if (Date.now() - meta.checkedAt < RECHECK_MS) return meta;
    const pageId = this.meta<string>("page_id");
    const row = await this.env.DB.prepare(
      `SELECT p.state AS state, m.role AS role FROM pages p
         LEFT JOIN members m ON m.workspace_id = p.workspace_id AND m.user_id = ?
       WHERE p.id = ?`,
    )
      .bind(meta.userId, pageId)
      .first<{ state: string; role: Role | null }>();
    if (!row || row.state === "deleted") {
      this.endSocket(ws, { type: "deleted" }, CLOSE.deleted);
      return null;
    }
    if (!row.role) {
      this.endSocket(ws, { type: "revoked" }, CLOSE.forbidden);
      return null;
    }
    if (row.state !== this.meta("state")) this.setMeta("state", row.state);
    const next = { ...meta, role: row.role, checkedAt: Date.now() };
    ws.serializeAttachment(next);
    return next;
  }

  private onAwareness(ws: WebSocket, update: Uint8Array): void {
    if (update.length > 16 * 1024) return;
    const meta = ws.deserializeAttachment() as SocketMeta;
    let clocks: { id: number; clock: number }[];
    try {
      clocks = awarenessClocks(update);
    } catch {
      return;
    }
    const known = new Map(meta.clients.map((c) => [c.id, c]));
    for (const c of clocks) known.set(c.id, c);
    meta.clients = [...known.values()].slice(-8);
    ws.serializeAttachment(meta);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, update);
    this.broadcast(encoding.toUint8Array(e), ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    if (meta.clients.length) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, encodeAwarenessRemoval(meta.clients));
      this.broadcast(encoding.toUint8Array(e), ws);
    }
    const stillOpen = this.ctx.getWebSockets(meta.userId).some((s) => s !== ws && s.readyState === WebSocket.OPEN);
    const pageId = this.meta<string>("page_id");
    if (!stillOpen && pageId) {
      await this.env.DB.prepare("DELETE FROM doc_sessions WHERE page_id = ? AND user_id = ?").bind(pageId, meta.userId).run();
    }
  }

  private broadcast(message: Uint8Array, except?: WebSocket): void {
    for (const s of this.ctx.getWebSockets()) {
      if (s === except || s.readyState !== WebSocket.OPEN) continue;
      try {
        s.send(message);
      } catch {
        /* socket closing */
      }
    }
  }

  private broadcastUpdate(update: Uint8Array, except?: WebSocket): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    this.broadcast(encoding.toUint8Array(e), except);
  }

  private endSocket(ws: WebSocket, control: Control, code: number): void {
    try {
      ws.send(encodeControl(control));
      ws.close(code, control.type);
    } catch {
      /* already closed */
    }
  }

  // ---------- RPC (called by the Worker after it has authorized the caller) ----------

  /** Canonical content and revision. */
  async read(pageId: string): Promise<{ doc: PMNode; revision: number }> {
    if (this.meta("page_id") == null) this.setMeta("page_id", pageId);
    return { doc: yToJSON(this.load().getXmlFragment(FRAGMENT)), revision: this.revision };
  }

  /** Structured edits (MCP/API). Goes through the same commit + broadcast path as editor updates. */
  async edit(
    pageId: string,
    ops: EditOp[],
    expectedRevision: number | null,
    /** Page state from D1 (authoritative); this object only hears about archive/restore while sockets are open. */
    state?: string,
  ): Promise<{ revision: number; insertedIds: string[]; warnings: string[]; changed: boolean } | { error: ReturnType<AppError["toJSON"]>["error"] }> {
    try {
      if (state && state !== this.meta("state")) this.setMeta("state", state);
      return this.editUnsafe(pageId, ops, expectedRevision);
    } catch (err) {
      // RPC drops custom error classes; return structured errors instead.
      if (err instanceof AppError) return { error: err.toJSON().error };
      throw err;
    }
  }

  private editUnsafe(pageId: string, ops: EditOp[], expectedRevision: number | null) {
    if (this.meta("page_id") == null) this.setMeta("page_id", pageId);
    if (this.meta("state") === "archived") throw new AppError("conflict", "Page is in the trash; restore it before editing");
    if (expectedRevision !== null && expectedRevision !== this.revision) {
      throw new AppError("conflict", `Document changed (now at revision ${this.revision}); re-read and retry`, {
        currentRevision: this.revision,
      });
    }
    const plan = planEdits(this.load(), ops);
    if (!preservesOwningReferences(this.load(), plan.update)) {
      throw new AppError("invalid_input", "Use page actions to create, move, or trash subpages");
    }
    const result = this.commit(plan.update, "agent");
    if (result?.effective.length) this.broadcastUpdate(result.effective);
    return { revision: result?.revision ?? this.revision, insertedIds: plan.insertedIds, warnings: plan.warnings, changed: !!result };
  }

  /** Set initial content once (page create/import). Idempotent: retries after a partial failure are no-ops. */
  async initialize(pageId: string, workspaceId: string, doc: PMNode): Promise<{ revision: number; applied: boolean }> {
    this.remember(pageId, workspaceId, this.meta<string>("state") ?? "active");
    if (this.meta("initialized") || this.load().getXmlFragment(FRAGMENT).length > 0) return { revision: this.revision, applied: false };
    const scratch = new Y.Doc();
    scratch.getXmlFragment(FRAGMENT).insert(0, (doc.content ?? []).map(jsonToY));
    const result = this.commit(Y.encodeStateAsUpdate(scratch), "init");
    this.setMeta("initialized", 1);
    return { revision: result?.revision ?? this.revision, applied: true };
  }

  /** Rebuild only owning links from current D1 metadata. Old outbox jobs cannot resurrect pages. */
  async reconcileChildPages(parentId: string, workspaceId: string): Promise<{ revision: number; changed: boolean }> {
    // Serialized so a later run always reads newer D1 rows. Not blockConcurrencyWhile: a throw there
    // (e.g. a transient D1 error) resets the object and drops every open editor.
    const run = this.reconciling.then(() => this.reconcileNow(parentId, workspaceId));
    this.reconciling = run.catch(() => {});
    return run;
  }

  private reconciling: Promise<unknown> = Promise.resolve();

  private async reconcileNow(parentId: string, workspaceId: string): Promise<{ revision: number; changed: boolean }> {
    {
      const parent = await this.env.DB.prepare("SELECT state, is_database, archive_root FROM pages WHERE id = ? AND workspace_id = ?")
        .bind(parentId, workspaceId).first<{ state: string; is_database: number; archive_root: string | null }>();
      if (!parent || parent.state === "deleted" || parent.is_database) return { revision: this.revision, changed: false };
      const children = await this.env.DB.prepare(`SELECT p.id, p.title, p.icon, a.after_block_id FROM pages p
        LEFT JOIN page_reference_anchors a ON a.child_id = p.id AND a.parent_id = p.parent_id
        WHERE p.workspace_id = ? AND p.parent_id = ? AND p.database_id IS NULL
          AND (p.state = 'active' OR (? = 'archived' AND p.state = 'archived' AND p.archive_root IS ?))
        ORDER BY p.position, p.id`)
        .bind(workspaceId, parentId, parent.state, parent.archive_root)
        .all<{ id: string; title: string; icon: string | null; after_block_id: string | null }>();
      this.remember(parentId, workspaceId, parent.state);
      const live = this.load();
      const scratch = new Y.Doc();
      Y.applyUpdate(scratch, Y.encodeStateAsUpdate(live));
      const fragment = scratch.getXmlFragment(FRAGMENT);
      const desired = new Map(children.results.map((c) => [c.id, c]));
      const seen = new Set<string>();
      scratch.transact(() => {
        const clean = (container: Y.XmlFragment | Y.XmlElement) => {
          for (let i = 0; i < container.length;) {
            const element = container.get(i);
            if (!(element instanceof Y.XmlElement)) { i++; continue; }
            if (element.nodeName === "childPage") {
              const id = String(element.getAttribute("pageId") ?? "");
              const child = desired.get(id);
              if (!child || seen.has(id)) { container.delete(i, 1); continue; }
              seen.add(id);
              if (!element.getAttribute("id")) element.setAttribute("id", blockId());
              if (element.getAttribute("title") !== child.title) element.setAttribute("title", child.title);
              if (element.getAttribute("icon") !== child.icon) element.setAttribute("icon", child.icon as unknown as string);
            } else clean(element);
            i++;
          }
        };
        clean(fragment);
        for (const child of children.results) {
          if (seen.has(child.id)) continue;
          const link = jsonToY({ type: "childPage", attrs: { id: blockId(), pageId: child.id, title: child.title, icon: child.icon } });
          const anchor = child.after_block_id ? topLevelAnchor(fragment, child.after_block_id) : null;
          if (anchor) {
            if (anchor.element.nodeName === "paragraph" && !anchor.element.toString().replace(/<[^>]*>/g, "")) {
              anchor.parent.delete(anchor.index, 1);
              anchor.parent.insert(anchor.index, [link]);
            } else anchor.parent.insert(anchor.index + 1, [link]);
          } else fragment.insert(fragment.length, [link]);
        }
      });
      const update = Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(live));
      const hasRefs = owningReferences(scratch).length > 0;
      scratch.destroy();
      const result = this.commit(update, "page-reference");
      if (result?.effective.length) {
        if (hasRefs) for (const ws of this.ctx.getWebSockets()) {
          if (((ws.deserializeAttachment() as SocketMeta | null)?.schemaVersion ?? 1) < 2) {
            this.endSocket(ws, { type: "upgrade-required", requiredSchemaVersion: 2 }, CLOSE.upgradeRequired);
          }
        }
        this.broadcastUpdate(result.effective);
      }
      return { revision: result?.revision ?? this.revision, changed: !!result };
    }
  }

  async setState(pageId: string, state: "active" | "archived"): Promise<void> {
    if (this.meta("page_id") == null) this.setMeta("page_id", pageId);
    this.setMeta("state", state);
    this.broadcast(encodeControl({ type: "state", state }));
  }

  /** Close every socket of a user whose access was removed. */
  async revokeUser(userId: string): Promise<number> {
    const sockets = this.ctx.getWebSockets(userId);
    for (const ws of sockets) this.endSocket(ws, { type: "revoked" }, CLOSE.forbidden);
    return sockets.length;
  }

  /** Permanent deletion: drop content and close sessions. The D1 tombstone prevents resurrection. */
  async purge(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) this.endSocket(ws, { type: "deleted" }, CLOSE.deleted);
    this.doc = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // deleteAll() drops the tables too; this instance may still get calls (socket close events, late RPCs).
    this.createTables();
  }

  /** Full state for backups (D1 holds metadata; this is the canonical body). */
  async exportState(): Promise<{ state: Uint8Array; revision: number }> {
    return { state: Y.encodeStateAsUpdate(this.load()), revision: this.revision };
  }

  async restoreState(pageId: string, workspaceId: string, state: Uint8Array): Promise<number> {
    this.remember(pageId, workspaceId, "active");
    return this.commit(state, "restore")?.revision ?? this.revision;
  }

  /** Test hook: drop the in-memory doc as if the object had been evicted. */
  async evictForTest(): Promise<void> {
    this.doc = null;
  }
}

/** Include identity and multiplicity: generic edits cannot forge, copy, or remove owning links. */
function owningReferences(doc: Y.Doc): string[] {
  const refs: string[] = [];
  // Walks Y elements only (no text conversion): this runs on every editor update.
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "childPage") refs.push(JSON.stringify([child.getAttribute("id"), child.getAttribute("pageId")]));
      else walk(child);
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  return refs.sort();
}

function preservesOwningReferences(doc: Y.Doc, update: Uint8Array): boolean {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const before = owningReferences(scratch);
    Y.applyUpdate(scratch, update);
    return JSON.stringify(before) === JSON.stringify(owningReferences(scratch));
  } finally { scratch.destroy(); }
}

/** Owning links are document blocks, even when a supplied cursor anchor names a list paragraph. */
function topLevelAnchor(fragment: Y.XmlFragment, id: string) {
  const found = findBlock(fragment, id);
  if (!found) return null;
  let element = found.element;
  while (element.parent instanceof Y.XmlElement) element = element.parent;
  const index = fragment.toArray().indexOf(element);
  return index < 0 ? null : { element, parent: fragment, index };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Would applying `update` add structs or delete items the doc still has? (No side effects.) */
export function wouldChange(doc: Y.Doc, update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  const sv = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const s of structs) {
    if (s instanceof Y.Skip) continue;
    if (s.id.clock + s.length > (sv.get(s.id.client) ?? 0)) return true;
  }
  const known = Y.createDeleteSetFromStructStore(doc.store);
  let checked = 0;
  for (const [client, ranges] of ds.clients) {
    for (const r of ranges) {
      for (let clock = r.clock; clock < r.clock + r.len; clock++) {
        if (++checked > 50_000) return true; // huge delete set: let commit() decide
        if (!Y.isDeleted(known, Y.createID(client, clock))) return true;
      }
    }
  }
  return false;
}
