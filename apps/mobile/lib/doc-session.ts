import { MSG_SYNC, SyncProvider, type SyncState } from "@workspace/core/sync";
import { addNetworkStateListener } from "expo-network";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { openSocket } from "./api";
import { type BridgeMsg, decodeMsg, type EditorHandle, encodeMsg } from "./bridge";
import { docStore, evict, openDoc, type Sql } from "./doc-store";

/** Origin of updates that came from the editor WebView (local edits as far as the provider is concerned). */
const WEBVIEW = "webview";
const SYNC_STEP2 = 1; // y-protocols messageYjsSyncStep2

export interface DocView {
  sync: SyncState;
  /** Local copy existed when the page was opened. */
  cached: boolean;
  /** The server's state has been received on this open. */
  serverState: boolean;
  /** The editor has been initialized (has something to show). */
  initialized: boolean;
  /** Uncached, and the server could not be reached. */
  unavailable: boolean;
}

/**
 * Native owner of one page's authoritative Y.Doc: SQLite DocStore + SyncProvider + the WebView bridge.
 * The WebView holds a replica fed through `applyInit`/`applyRemote`; its edits come back as updates.
 */
export class DocSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly provider: SyncProvider;
  private handle: EditorHandle | null = null;
  private editable = false;
  private started = false;
  private stopped = false;
  private listeners = new Set<() => void>();
  view: DocView;

  constructor(
    private sql: Sql,
    readonly pageId: string,
    private workspaceId: string,
    private title: string,
  ) {
    // The WebView's own awareness client carries our presence; the native doc has none of its own.
    this.awareness.setLocalState(null);
    this.provider = new SyncProvider({
      doc: this.doc,
      awareness: this.awareness,
      store: docStore(sql, pageId),
      connect: () => this.connect(),
      onState: (sync) => this.set({ sync }),
    });
    this.view = { sync: this.provider.current, cached: false, serverState: false, initialized: false, unavailable: false };
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getView = () => this.view;

  private set(patch: Partial<DocView>) {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((l) => l());
  }

  private async connect(): Promise<WebSocket> {
    const ws = await openSocket(`/sync/${this.pageId}`);
    ws.addEventListener("message", (e: MessageEvent) => {
      if (this.view.serverState) return;
      const d = new Uint8Array(e.data as ArrayBuffer);
      // Server's step 2 = its full state. Defer so the provider (listening after us) applies it first.
      if (d[0] === MSG_SYNC && d[1] === SYNC_STEP2)
        setTimeout(() => {
          this.set({ serverState: true, unavailable: false });
          this.maybeInit();
        }, 0);
    });
    ws.addEventListener("close", () => {
      if (!this.view.serverState && !this.view.cached) this.set({ unavailable: true });
    });
    return ws;
  }

  async start(): Promise<void> {
    const { cached } = await openDoc(this.sql, this.pageId, this.workspaceId, this.title);
    if (this.stopped) return;
    this.set({ cached });
    await this.provider.start();
    if (this.stopped) return;
    this.started = true;
    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    void evict(this.sql, this.pageId).catch((err) => console.warn("evict failed", err));
    this.maybeInit();
  }

  /** The WebView (re)mounted: it holds an empty replica until it gets the full state again. */
  attach(handle: EditorHandle) {
    this.handle = handle;
    this.set({ initialized: false });
    this.maybeInit();
  }

  /** Cached docs open immediately; uncached ones wait for the server so the editor never binds an empty doc. */
  private maybeInit() {
    const h = this.handle;
    if (!h || !this.started || this.view.initialized || (!this.view.cached && !this.view.serverState)) return;
    h.applyInit(encodeMsg(Y.encodeStateAsUpdate(this.doc)));
    h.setEditable(this.editable);
    const others = [...this.awareness.getStates().keys()];
    if (others.length) h.applyAwareness(encodeMsg(encodeAwarenessUpdate(this.awareness, others)));
    this.set({ initialized: true });
  }

  setEditable(editable: boolean) {
    this.editable = editable;
    if (this.view.initialized) this.handle?.setEditable(editable);
  }

  /** Incremental update typed in the WebView: the provider persists it (SQLite) and sends it. */
  localUpdate(msg: BridgeMsg) {
    Y.applyUpdate(this.doc, decodeMsg(msg), WEBVIEW);
  }

  localAwareness(msg: BridgeMsg) {
    applyAwarenessUpdate(this.awareness, decodeMsg(msg), WEBVIEW);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== WEBVIEW && this.view.initialized) this.handle?.applyRemote(encodeMsg(update));
  };

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === WEBVIEW || !this.view.initialized) return;
    this.handle?.applyAwareness(encodeMsg(encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed])));
  };

  destroy() {
    this.stopped = true;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.handle = null;
    this.provider.destroy();
    this.awareness.destroy();
    // Pending SQLite appends still hold the updates; let them finish before freeing the doc.
    void this.provider.flushLocal().finally(() => this.doc.destroy());
  }
}

/** One DocSession per mounted page screen, wired to app lifecycle and network changes. */
export function useDocSession(sql: Sql, pageId: string, workspaceId: string | null, title: string) {
  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    const s = new DocSession(sql, pageId, workspaceId, title);
    setSession(s);
    void s.start().catch((err) => console.error("doc session failed", err));
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") s.provider.reconnectNow();
      else if (state === "background") void s.provider.flushLocal();
    });
    const net = addNetworkStateListener((n) => n.isConnected && n.isInternetReachable !== false && s.provider.reconnectNow());
    return () => {
      app.remove();
      net.remove();
      s.destroy();
    };
    // The title only seeds the drafts list; reopening the doc for a rename would drop the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, pageId, workspaceId]);
  return session;
}

const EMPTY: DocView = {
  sync: { phase: "loading", connected: false, pendingLocal: false, revision: null, readOnly: false, failure: null },
  cached: false,
  serverState: false,
  initialized: false,
  unavailable: false,
};
const noop = () => () => {};

export function useDocView(session: DocSession | null): DocView {
  return useSyncExternalStore(session?.subscribe ?? noop, session?.getView ?? (() => EMPTY));
}
