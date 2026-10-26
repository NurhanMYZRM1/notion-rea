import "@workspace/editor/styles.css";
import { type PageDetail } from "@workspace/core";
import { useQueryClient } from "@tanstack/react-query";
import { invalidatePage, qk } from "../queries";
import { createSubpage } from "../subpages";
import { MoveDialog } from "../shell/dialogs";
import { Awareness, DOCUMENT_SCHEMA_VERSION, SyncProvider, type SyncState } from "@workspace/core/sync";
import { type ChildPageHost, type Uploaded, WorkspaceEditor } from "@workspace/editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { api, download, errorMessage, fileSafe } from "../api";
import type { Peer } from "../pages/PageView";
import { Link, navigate } from "../router";
import { docKey, openKeys } from "../sync/cache-db";
import { docMarkdown, enforceLimits, type IdbDocStore, openDocStore } from "../sync/idb-store";
import { Spinner, type Store, toast, useOnline } from "../ui";

interface Props {
  pageId: string;
  workspaceId: string;
  title: string;
  editable: boolean;
  user: { name: string; color: string };
  syncStore: Store<SyncState | null>;
  presence: Store<Peer[]>;
}

interface Session {
  doc: Y.Doc;
  provider: SyncProvider;
  awareness: Awareness;
  store: IdbDocStore | null;
  /** The device had a stored copy when the page opened (false = nothing to show offline). */
  hadContent: boolean;
}

const MAX_IMAGE_SIDE = 2048;
const UPLOAD_OFFLINE = "You're offline. Uploading files needs a connection.";

/** Large photos are downscaled on a canvas before upload (keeps attachments small and fast to sync). */
async function downscale(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file; // GIFs would lose animation
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height);
  if (scale >= 1) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.9));
  return out ?? file;
}

const showError = (message: string) => toast(message, "error");

/** One Y.Doc + Awareness + SyncProvider per open page, persisted in the per-account IndexedDB cache. */
export default function DocEditor(props: Props) {
  const { pageId, workspaceId, syncStore, presence } = props;
  const qc = useQueryClient();
  const created = useRef(new Set<string>());
  const [moving, setMoving] = useState<PageDetail | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<SyncState | null>(null);
  // Once connected, the device copy holds the server's content, so it's safe to show offline.
  const [connectedOnce, setConnectedOnce] = useState(false);
  const online = useOnline();
  const coarse = useMemo(() => window.matchMedia("(pointer: coarse)").matches, []);

  useEffect(() => {
    let cancelled = false;
    let provider: SyncProvider | null = null;
    let socket: WebSocket | null = null;
    // The provider reports "offline" before its first connection attempt; hold that until the attempt resolves.
    let settled = !navigator.onLine;
    let latest: SyncState | null = null;
    let peersSig = "";
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const key = docKey(workspaceId, pageId);
    openKeys.add(key);

    const publish = () => {
      if (!latest || (!settled && latest.phase === "offline")) return;
      syncStore.set(latest);
      setState(latest);
      if (latest.connected) setConnectedOnce(true);
    };
    const settle = () => {
      settled = true;
      publish();
    };
    const onPresence = () => {
      const peers: Peer[] = [];
      const seen = new Set<string>();
      awareness.getStates().forEach((s, id) => {
        const u = (s as { user?: { name?: string; color?: string } }).user;
        if (id === doc.clientID || !u?.name || seen.has(u.name + u.color)) return;
        seen.add(u.name + u.color);
        peers.push({ key: String(id), name: u.name, color: u.color ?? "#555" });
      });
      const sig = peers.map((p) => p.key + p.name + p.color).join("|");
      if (sig !== peersSig) {
        peersSig = sig;
        presence.set(peers);
      }
    };
    awareness.on("change", onPresence);

    const connect = () => {
      if (!navigator.onLine) throw new Error("offline"); // the provider retries with backoff; "online" retries now
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/sync/${pageId}?schema=${DOCUMENT_SCHEMA_VERSION}`);
      socket = ws;
      ws.addEventListener("open", settle, { once: true });
      ws.addEventListener("close", settle, { once: true });
      return ws;
    };
    const onOnline = () => provider?.reconnectNow();
    // Browsers can keep a dead socket open for a long time after losing the network.
    const onOffline = () => {
      settle();
      socket?.close();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    void (async () => {
      let store: IdbDocStore | null = null;
      let hadContent = false;
      try {
        store = await openDocStore(workspaceId, pageId, props.title);
        const load = store.load.bind(store);
        store.load = async () => {
          const r = await load();
          hadContent = r.updates.length > 0;
          return r;
        };
      } catch (err) {
        console.warn("offline document cache unavailable", err);
      }
      if (cancelled) return;
      const make = (s: IdbDocStore | null) =>
        new SyncProvider({
          doc,
          awareness,
          store: s,
          connect,
          onState: (st) => {
            latest = st;
            publish();
          },
        });
      provider = make(store);
      try {
        await provider.start();
      } catch (err) {
        console.warn("couldn't read the stored copy; continuing without it", err);
        provider.destroy();
        if (cancelled) return;
        store = null;
        provider = make(null);
        await provider.start();
      }
      if (cancelled) return;
      setSession({ doc, provider, awareness, store, hadContent });
      void enforceLimits().catch(() => {});
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      awareness.off("change", onPresence);
      presence.set([]);
      syncStore.set(null);
      const finish = () => {
        openKeys.delete(key);
        awareness.destroy();
        doc.destroy();
      };
      const p = provider;
      if (!p) return finish();
      // Local writes must reach IndexedDB before the provider (and its pending batch) goes away.
      void p.flushLocal().finally(() => {
        p.destroy();
        finish();
      });
    };
    // props.title is only the initial cache label; a rename must not reopen the document.
  }, [pageId, workspaceId, syncStore, presence]);

  useEffect(() => session?.store?.setTitle(props.title), [session, props.title]);

  const upload = useCallback(
    async (file: File): Promise<Uploaded> => {
      if (!navigator.onLine) throw new Error(UPLOAD_OFFLINE);
      const body = await downscale(file);
      return api.upload(pageId, { name: file.name, type: body.type || file.type, size: body.size, body });
    },
    [pageId],
  );
  const onReady = useCallback(() => performance.mark("page-editable"), []);
  const childPages = useMemo<ChildPageHost>(() => ({
    resolve: async (ids) => (await Promise.all(ids.map(async (id) => {
      try { const page = await qc.fetchQuery({ queryKey:qk.page(id), queryFn:() => api.page(id).then((r) => r.page), staleTime:30_000 });
        return page.workspaceId === workspaceId && page.parentId === pageId && page.state === "active" ? { id:page.id,title:page.title,icon:page.icon } : null;
      } catch { return null; }
    }))).filter((p): p is { id:string; title:string; icon:string|null } => p !== null),
    create: async (anchor) => {
      if (!session || !navigator.onLine) throw new Error("Creating a subpage needs a connection.");
      await session.provider.awaitSynced();
      const { page } = await createSubpage(pageId, anchor.afterBlockId);
      created.current.add(page.id);
      invalidatePage(qc, page);
      return { id:page.id,title:page.title,icon:page.icon };
    },
    open: (id) => { const isNew = created.current.delete(id); navigate(`/p/${id}${isNew ? "?new=1" : ""}`); },
    archive: async (id) => {
      if (!session || !navigator.onLine) throw new Error("Moving a subpage to Trash needs a connection.");
      await session.provider.awaitSynced();
      const { page:latest } = await api.page(id);
      if (latest.workspaceId !== workspaceId || latest.parentId !== pageId || latest.state !== "active") throw new Error("This page moved elsewhere. Refresh the parent before removing it.");
      const { page } = await api.archivePage(id, { expectedParentId:pageId });
      invalidatePage(qc, page);
      toast("Page and its subpages moved to Trash", "info", { label:"Undo", onClick:() => { void api.restorePage(id).then(({ page:restored }) => { invalidatePage(qc, restored); toast("Page restored"); }).catch((err) => toast(errorMessage(err), "error")); } });
    },
    move: (id) => { void api.page(id).then(({ page }) => setMoving(page)).catch((err) => toast(errorMessage(err), "error")); },
    subscribe: (listener) => qc.getQueryCache().subscribe((event) => { if (event.type === "updated" && event.query.queryKey[0] === "page" && (event.action.type === "invalidate" || event.action.type === "success")) listener(); }),
  }), [session, qc, pageId, workspaceId]);


  if (!session) return <Spinner label="Opening page" />;

  const failure = state?.failure ?? null;
  const readOnly = state?.readOnly ?? false;
  const editable = props.editable && !readOnly && !failure;
  const uncached = !session.hadContent && !online && !connectedOnce;
  const exportDraft = () => download(`${fileSafe(props.title)} (draft).md`, docMarkdown(session.doc));

  return (
    <>
      {failure === "upgrade-required" && <div className="banner banner-error" role="alert">This page uses a newer editor version. Update the app to edit it. Your local draft is preserved.</div>}
      {(failure === "revoked" || failure === "deleted" || failure === "error") && (
        <div className="banner banner-error" role="alert">
          <span>
            {failure === "error" ? "This page couldn't sync because of a server error." : "You no longer have access to this page."} Your unsynced changes are kept on
            this device as a draft.
          </span>
          <button type="button" className="btn btn-small" onClick={exportDraft}>
            Export draft (Markdown)
          </button>
        </div>
      )}
      {failure === "unauthenticated" && (
        <div className="banner banner-error" role="alert">
          <span>You've been signed out. Your changes are kept on this device; sign in again to sync them.</span>
          <Link className="btn btn-small" to={`/login?next=${encodeURIComponent(location.pathname)}`}>
            Sign in
          </Link>
        </div>
      )}
      {!failure && readOnly && props.editable && (
        <div className="banner banner-info" role="status">
          {readOnly === "viewer" ? "Your role changed to viewer: this page is now read-only." : "This page was moved to the trash and is read-only."}
        </div>
      )}
      {uncached ? (
        <p className="editor-note">This page's content isn't saved on this device yet. It will appear when you're back online.</p>
      ) : (
        <WorkspaceEditor
          doc={session.doc}
          awareness={session.awareness}
          user={props.user}
          editable={editable}
          upload={upload}
          onError={showError}
          onReady={onReady}
          childPages={childPages}
          toolbar={coarse ? "fixed" : "bubble"}
        />
      )}
      {moving && <MoveDialog page={moving} onClose={() => setMoving(null)} />}
    </>
  );
}
