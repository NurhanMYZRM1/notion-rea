import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { CLOSE, MSG_ACK, MSG_AWARENESS, MSG_CONTROL, MSG_SYNC, type Control, readAck, readControl } from "./protocol";

/** Durable local copy of one document (IndexedDB on web, SQLite on mobile). */
export interface DocStore {
  /** Stored updates plus local-edit counters. `localCounter > syncedCounter` means unsynchronized edits. */
  load(): Promise<{ updates: Uint8Array[]; localCounter: number; syncedCounter: number }>;
  /** Resolve only once the update is durable on the device. `localCounter` is null for remote updates. */
  append(update: Uint8Array, localCounter: number | null): Promise<void>;
  /** Local edits up to `counter` are committed on the server at `revision`. */
  markSynced(counter: number, revision: number): Promise<void>;
}

export type SyncPhase =
  | "loading"
  | "saving-local" // a local edit is being written to the device
  | "saved-device" // all edits are on the device, some not yet on the server
  | "syncing" // connected; edits in flight
  | "synced" // server has committed every local edit
  | "offline" // not connected, nothing pending
  | "failed"; // server refused the session; local edits kept as a draft

export interface SyncState {
  phase: SyncPhase;
  connected: boolean;
  pendingLocal: boolean;
  revision: number | null;
  readOnly: false | "viewer" | "archived";
  failure: null | "revoked" | "deleted" | "unauthenticated" | "upgrade-required" | "error";
}

export interface ProviderOptions {
  doc: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  store: DocStore | null;
  /** Open an authenticated socket for this page (web: same-origin cookie; native: Cookie header). */
  connect: () => WebSocket | Promise<WebSocket>;
  onState?: (state: SyncState) => void;
  /** Merge local updates for up to this long before sending (typing stays local and instant). */
  batchMs?: number;
}

const LOCAL_STORE = Symbol("store");
// lib0 returns Uint8Array<ArrayBufferLike>; WebSocket.send wants an ArrayBuffer-backed view.
const bytes = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

export class SyncProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private store: DocStore | null;
  private ws: WebSocket | null = null;
  private handshakeDone = false;
  private localCounter = 0;
  private syncedCounter = 0;
  private pendingAppends = 0;
  private appendChain: Promise<void> = Promise.resolve();
  /** Local counter covered by each sent-but-unacknowledged message, oldest first. */
  private inflight: number[] = [];
  private batch: Uint8Array[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  /** Until the first connection attempt finishes we are "loading", not "offline". */
  private attempted = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private syncWaiters = new Set<() => void>();
  private state: SyncState = {
    phase: "loading",
    connected: false,
    pendingLocal: false,
    revision: null,
    readOnly: false,
    failure: null,
  };

  constructor(private opts: ProviderOptions) {
    this.doc = opts.doc;
    this.store = opts.store;
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(this.doc);
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  get current(): SyncState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.store) {
      const saved = await this.store.load();
      this.localCounter = saved.localCounter;
      this.syncedCounter = saved.syncedCounter;
      Y.transact(this.doc, () => saved.updates.forEach((u) => Y.applyUpdate(this.doc, u, LOCAL_STORE)), LOCAL_STORE);
    }
    this.emit({});
    void this.open();
  }

  /** Try now instead of waiting for backoff (network came back, app foregrounded). */
  reconnectNow(): void {
    if (this.stopped || this.state.failure || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    void this.open();
  }

  destroy(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushBatch();
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.ws?.close(1000);
    this.ws = null;
    this.emit({ connected: false });
  }

  /** Wait until local writes are on the device (used before navigation/background). */
  flushLocal(): Promise<void> {
    return this.appendChain;
  }

  /** Flush pending edits and wait for a durable server ACK, including the initial handshake. */
  awaitSynced(timeoutMs = 15_000): Promise<void> {
    this.flushBatch();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        this.syncWaiters.delete(check);
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const s = this.state;
        if (this.stopped) return finish(new Error("Document session closed"));
        if (s.failure) return finish(new Error(s.failure === "upgrade-required" ? "Update the app to edit this page" : `Document sync failed: ${s.failure}`));
        if (s.readOnly) return finish(new Error("This page is read-only"));
        if (!s.connected && this.attempted) return finish(new Error("Connect to the internet to change page structure"));
        if (s.connected && this.handshakeDone && this.inflight.length === 0 && this.batch.length === 0 && this.syncedCounter >= this.localCounter && this.pendingAppends === 0) finish();
      };
      this.syncWaiters.add(check);
      timer = setTimeout(() => finish(new Error("Timed out waiting for the page to finish syncing")), timeoutMs);
      check();
    });
  }

  private emit(patch: Partial<SyncState>) {
    const s = { ...this.state, ...patch };
    s.pendingLocal = this.localCounter > this.syncedCounter;
    if (s.failure) s.phase = "failed";
    else if (this.pendingAppends > 0) s.phase = "saving-local";
    else if (!s.connected) s.phase = s.pendingLocal ? "saved-device" : this.attempted ? "offline" : "loading";
    else s.phase = !this.handshakeDone || s.pendingLocal || this.inflight.length || this.batch.length ? "syncing" : "synced";
    this.state = s;
    this.opts.onState?.(s);
    for (const check of this.syncWaiters) check();
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOCAL_STORE) return;
    const local = origin !== this;
    const counter = local ? ++this.localCounter : null;
    this.persist(update, counter);
    if (local) this.queueSend(update);
    this.emit({});
  };

  private persist(update: Uint8Array, counter: number | null) {
    if (!this.store) return;
    const store = this.store;
    this.pendingAppends++;
    this.appendChain = this.appendChain
      .then(() => store.append(update, counter))
      .catch((err) => {
        console.error("local save failed", err);
      })
      .finally(() => {
        this.pendingAppends--;
        this.emit({});
      });
  }

  private queueSend(update: Uint8Array) {
    if (!this.ws || !this.handshakeDone) return; // sent as part of the next handshake
    this.batch.push(update);
    if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushBatch(), this.opts.batchMs ?? 40);
  }

  private flushBatch() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.batch.length || !this.ws || !this.handshakeDone) return;
    const merged = this.batch.length === 1 ? this.batch[0]! : Y.mergeUpdates(this.batch);
    this.batch = [];
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, merged);
    this.send(encoding.toUint8Array(e), this.localCounter);
  }

  private send(message: Uint8Array, covers: number | null) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(bytes(message));
    if (covers !== null) this.inflight.push(covers);
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this || !this.ws || this.ws.readyState !== 1) return;
    const changed = [...added, ...updated, ...removed];
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.ws.send(bytes(encoding.toUint8Array(e)));
  };

  private async open() {
    if (this.stopped || this.ws) return;
    let ws: WebSocket;
    try {
      ws = await this.opts.connect();
    } catch {
      this.attempted = true;
      this.emit({});
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return ws.close(1000);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.handshakeDone = false;
    this.inflight = [];
    const onOpen = () => {
      this.retry = 0;
      this.emit({ connected: true });
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, this.doc);
      ws.send(bytes(encoding.toUint8Array(e)));
      if (this.awareness.getLocalState() !== null) this.onAwarenessUpdate({ added: [this.doc.clientID], updated: [], removed: [] }, null);
    };
    ws.addEventListener("message", (event: MessageEvent) => this.onMessage(new Uint8Array(event.data as ArrayBuffer)));
    ws.addEventListener("close", (event: CloseEvent) => this.onClose(ws, event.code));
    // Sockets handed over already open (e.g. accepted server-side in tests) never fire "open".
    if (ws.readyState === 1) onOpen();
    else ws.addEventListener("open", onOpen);
  }

  private onMessage(data: Uint8Array) {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      const kind = syncProtocol.readSyncMessage(d, e, this.doc, this);
      if (kind === syncProtocol.messageYjsSyncStep1) {
        // Our reply (step2) carries every local edit the server lacks, including offline ones.
        this.handshakeDone = true;
        this.batch = [];
        this.send(encoding.toUint8Array(e), this.localCounter);
      }
      this.emit({});
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
    } else if (type === MSG_ACK) {
      const revision = readAck(d);
      const covered = this.inflight.shift();
      if (covered !== undefined && covered > this.syncedCounter) {
        this.syncedCounter = covered;
        const store = this.store;
        if (store) this.appendChain = this.appendChain.then(() => store.markSynced(covered, revision)).catch(() => {});
      }
      this.emit({ revision });
    } else if (type === MSG_CONTROL) {
      this.onControl(readControl(d));
    }
  }

  private onControl(c: Control) {
    if (c.type === "hello") this.emit({ revision: c.revision, readOnly: c.role === "viewer" ? "viewer" : c.state === "archived" ? "archived" : false });
    else if (c.type === "read-only") this.emit({ readOnly: c.reason });
    else if (c.type === "state") this.emit({ readOnly: c.state === "archived" ? "archived" : this.state.readOnly === "viewer" ? "viewer" : false });
    else if (c.type === "revoked") this.emit({ failure: "revoked" });
    else if (c.type === "deleted") this.emit({ failure: "deleted" });
    else if (c.type === "upgrade-required") this.emit({ failure: "upgrade-required" });
    else if (c.type === "error") this.emit({ failure: "error" });
  }

  private onClose(ws: WebSocket, code: number) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.attempted = true;
    this.handshakeDone = false;
    this.inflight = [];
    const others = Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    if (code === CLOSE.unauthenticated) this.state.failure = "unauthenticated";
    else if (code === CLOSE.forbidden) this.state.failure ??= "revoked";
    else if (code === CLOSE.deleted || code === CLOSE.notFound) this.state.failure ??= "deleted";
    else if (code === CLOSE.upgradeRequired) this.state.failure = "upgrade-required";
    this.emit({ connected: false });
    if (!this.state.failure) this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry) * (0.5 + Math.random() / 2);
    this.retry = Math.min(this.retry + 1, 5);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }
}
