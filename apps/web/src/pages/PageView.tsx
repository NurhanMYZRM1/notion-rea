import { ApiRequestError, can, type Me, newId, type PageDetail, type PageSummary } from "@workspace/core";
import type { SyncState } from "@workspace/core/sync";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, conflictCurrent, download, errorMessage, fileSafe, initials, userColor } from "../api";
import { RecordProperties } from "../database/cells";
import { UnsyncedDrafts } from "../drafts";
import { invalidatePage, qk, roleIn, usePage } from "../queries";
import { Link, navigate, setSearchParam, useLocation } from "../router";
import { MoveDialog, Warnings } from "../shell/dialogs";
import { createPageIn, TopBar } from "../shell/Shell";
import { createStore, Dialog, Menu, OnlineButton, relTime, Spinner, type Store, toast, useOnline, useStore } from "../ui";

const DocEditor = lazy(() => import("../editor/DocEditor"));
const DatabaseView = lazy(() => import("../database/DatabaseView"));

export interface Peer {
  key: string;
  name: string;
  color: string;
}

export default function PageView({ id, me }: { id: string; me: Me }) {
  const qc = useQueryClient();
  const q = usePage(id);
  // A 404 on refetch wins over cached metadata (the page was deleted or access was lost).
  const gone = q.isError && q.error instanceof ApiRequestError && q.error.status === 404;
  const page = gone ? undefined : q.data;
  const { search } = useLocation();
  const [syncStore] = useState(() => createStore<SyncState | null>(null));
  const [presence] = useState(() => createStore<Peer[]>([]));
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const user = useMemo(() => ({ name: me.user.name || me.user.email, color: userColor(me.user.id) }), [me.user.name, me.user.email, me.user.id]);

  useEffect(() => {
    if (page) document.title = `${page.title || "Untitled"} · Workspace`;
  }, [page]);
  const wsId = page?.workspaceId;
  useEffect(() => {
    if (!wsId || !navigator.onLine) return;
    api
      .visit(id)
      .then(() => qc.invalidateQueries({ queryKey: qk.recents(wsId) }))
      .catch(() => {});
  }, [id, wsId, qc]);

  if (!page) {
    const offline = q.isError && q.error instanceof ApiRequestError && q.error.code === "network";
    return (
      <>
        <TopBar />
        {q.isPending && q.fetchStatus !== "paused" ? (
          <Spinner label="Loading page" />
        ) : (
          <div className="center-card">
            {offline || q.fetchStatus === "paused" ? (
              <>
                <h1>Not available offline</h1>
                <p className="muted">This page hasn't been opened on this device yet. It will load when you're back online.</p>
              </>
            ) : (
              <>
                <UnsyncedDrafts />
                <h1>Page not found</h1>
                <p className="muted">{q.error instanceof ApiRequestError && q.error.status === 404 ? "It may have been deleted, or you don't have access." : errorMessage(q.error)}</p>
              </>
            )}
            <Link to="/" className="btn">
              Go home
            </Link>
          </div>
        )}
      </>
    );
  }

  const role = roleIn(me, page.workspaceId);
  const archived = page.state !== "active";
  const canWrite = can(role, "write");
  const editable = canWrite && !archived;
  const canArchive = can(role, "archive");

  const exportMd = async () => {
    try {
      const r = await api.exportMarkdown(id);
      download(`${fileSafe(page.title)}.md`, r.markdown);
      if (r.warnings.length) setWarnings(r.warnings);
      else toast("Markdown exported");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const trash = async () => {
    try {
      await api.archivePage(id);
      invalidatePage(qc, page);
      toast("Moved to trash");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const restore = async () => {
    try {
      await api.restorePage(id);
      invalidatePage(qc, page);
      toast("Page restored");
    } catch (err) {
      const root = err instanceof ApiRequestError ? (err.details as { archiveRoot?: string } | undefined)?.archiveRoot : undefined;
      if (root) {
        toast("This page was trashed with its parent. Restore the parent instead.", "error");
        navigate(`/p/${root}`);
      } else toast(errorMessage(err), "error");
    }
  };
  const offlineReason = navigator.onLine ? null : "Needs a connection";

  return (
    <>
      <TopBar>
        <Breadcrumbs page={page} />
        <div className="topbar-actions">
          {!page.isDatabase && <SyncStatus store={syncStore} />}
          <Presence store={presence} />
          <FavoriteButton page={page} />
          <button type="button" className={`icon-btn ${commentsOpen ? "is-on" : ""}`} aria-pressed={commentsOpen} aria-label="Comments" title="Comments" onClick={() => setCommentsOpen((o) => !o)}>
            💬
          </button>
          <Menu
            label="Page actions"
            items={[
              { label: "Export Markdown", onSelect: () => void exportMd(), disabledReason: offlineReason },
              editable && !page.databaseId && !page.isDatabase && { label: "Add a sub-page", onSelect: () => void createPageIn(qc, page.workspaceId, id), disabledReason: offlineReason },
              editable && !page.databaseId && { label: "Move to…", onSelect: () => setMoveOpen(true), disabledReason: offlineReason },
              canArchive && !archived && { label: "Move to trash", onSelect: () => void trash(), danger: true, disabledReason: offlineReason },
            ]}
          >
            ⋯
          </Menu>
        </div>
      </TopBar>
      {role === "viewer" && !archived && (
        <div className="banner banner-info page-banner" role="region" aria-label="View only">
          You can view this page but not edit it. Ask a workspace owner for edit access.
        </div>
      )}
      {archived && (
        <div className="banner banner-warn page-banner" role="region" aria-label="Page in trash">
          <span>This page is in the trash{page.archivedAt ? ` (moved ${relTime(page.archivedAt)})` : ""}. It's read-only until restored.</span>
          {canArchive && (
            <OnlineButton className="btn btn-small" onClick={() => void restore()}>
              Restore
            </OnlineButton>
          )}
        </div>
      )}
      <div className={`page-layout ${commentsOpen ? "with-comments" : ""}`}>
        <article className={`doc ${page.isDatabase ? "doc-wide" : ""}`} aria-label={page.title || "Untitled"}>
          <div className="page-head">
            <IconField page={page} editable={editable} />
            <TitleField page={page} editable={editable} autoFocus={search.get("new") === "1"} />
          </div>
          {page.databaseId && <RecordProperties recordId={id} databaseId={page.databaseId} editable={editable} />}
          <Suspense fallback={<Spinner label="Loading editor" />}>
            {page.isDatabase ? (
              <DatabaseView id={id} ws={page.workspaceId} canWrite={editable} />
            ) : (
              <DocEditor pageId={id} workspaceId={page.workspaceId} title={page.title} editable={editable} user={user} syncStore={syncStore} presence={presence} />
            )}
          </Suspense>
        </article>
        {commentsOpen && <CommentsPanel pageId={id} me={me} canComment={canWrite} onClose={() => setCommentsOpen(false)} />}
      </div>
      {moveOpen && <MoveDialog page={page} onClose={() => setMoveOpen(false)} />}
      {warnings && (
        <Dialog title="Exported with warnings" onClose={() => setWarnings(null)}>
          <p>The Markdown file was downloaded. Some content couldn't be represented exactly:</p>
          <Warnings warnings={warnings} />
        </Dialog>
      )}
    </>
  );
}

function Breadcrumbs({ page }: { page: PageDetail }) {
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        {page.breadcrumbs.map((c) => (
          <li key={c.id}>
            <Link to={`/p/${c.id}`}>{c.title || "Untitled"}</Link>
            <span aria-hidden="true" className="crumb-sep">
              /
            </span>
          </li>
        ))}
        <li>
          <span aria-current="page" className="crumb-current">
            {page.icon ? `${page.icon} ` : ""}
            {page.title || "Untitled"}
          </span>
        </li>
      </ol>
    </nav>
  );
}

const PHASE_LABEL: Record<SyncState["phase"], string> = {
  loading: "Loading…",
  "saving-local": "Saving locally…",
  "saved-device": "Saved on device",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  failed: "Couldn't sync",
};

export function SyncStatus({ store }: { store: Store<SyncState | null> }) {
  const s = useStore(store);
  if (!s) return null;
  const label = PHASE_LABEL[s.phase] + (s.phase === "saved-device" && !s.connected ? " · offline" : "");
  const hint =
    s.phase === "saved-device"
      ? "Your edits are stored on this device and will sync when you reconnect."
      : s.phase === "synced"
        ? "Every edit is saved on the server."
        : s.phase === "failed"
          ? "The server refused this session. Your local edits are kept."
          : label;
  return (
    <span className={`sync-status phase-${s.phase}`} data-phase={s.phase} title={hint}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function Presence({ store }: { store: Store<Peer[]> }) {
  const peers = useStore(store);
  if (!peers.length) return null;
  return (
    <div className="avatars" role="img" aria-label={`Also here: ${peers.map((p) => p.name).join(", ")}`}>
      {peers.slice(0, 4).map((p) => (
        <span key={p.key} className="avatar" style={{ background: p.color }} title={p.name}>
          {initials(p.name)}
        </span>
      ))}
      {peers.length > 4 && <span className="avatar avatar-more">+{peers.length - 4}</span>}
    </div>
  );
}

function FavoriteButton({ page }: { page: PageDetail }) {
  const qc = useQueryClient();
  const toggle = async () => {
    const favorite = !page.favorite;
    qc.setQueryData<PageDetail>(qk.page(page.id), (p) => (p ? { ...p, favorite } : p));
    try {
      await api.setFavorite(page.id, favorite);
    } catch (err) {
      qc.setQueryData<PageDetail>(qk.page(page.id), (p) => (p ? { ...p, favorite: !favorite } : p));
      toast(errorMessage(err), "error");
    }
    void qc.invalidateQueries({ queryKey: qk.favorites(page.workspaceId) });
  };
  return (
    <OnlineButton className={`icon-btn ${page.favorite ? "is-on" : ""}`} aria-pressed={page.favorite} aria-label="Favorite" title={page.favorite ? "Remove from favorites" : "Add to favorites"} onClick={() => void toggle()}>
      {page.favorite ? "★" : "☆"}
    </OnlineButton>
  );
}

/** Titles and icons also show in the tree, favorites and recents (the event channel only invalidates the tree). */
function invalidateListings(qc: QueryClient, page: PageDetail) {
  void qc.invalidateQueries({ queryKey: qk.children(page.workspaceId, page.parentId) });
  void qc.invalidateQueries({ queryKey: qk.recents(page.workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.favorites(page.workspaceId) });
}

/** Saves title edits with the page revision; on 409 keeps whichever value is newer. */
function TitleField({ page, editable, autoFocus }: { page: PageDetail; editable: boolean; autoFocus: boolean }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(page.title);
  const dirty = useRef(false);
  const editedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!dirty.current) setValue(page.title);
  }, [page.title]);
  useEffect(() => {
    if (autoFocus && editable) {
      ref.current?.focus();
      setSearchParam("new", null);
    }
  }, [autoFocus, editable]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = async (title: string) => {
    let revision = qc.getQueryData<PageDetail>(qk.page(page.id))?.revision ?? page.revision;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await api.updatePage(page.id, { expectedRevision: revision, title });
        qc.setQueryData<PageDetail>(qk.page(page.id), (p) => (p ? { ...p, title: r.page.title, revision: r.page.revision, updatedAt: r.page.updatedAt } : p));
        if (ref.current?.value === title) dirty.current = false;
        invalidateListings(qc, page);
        if (page.databaseId) void qc.invalidateQueries({ queryKey: qk.database(page.databaseId) });
        return;
      } catch (err) {
        const current = conflictCurrent<PageSummary>(err);
        if (!current) {
          toast(`Title not saved: ${errorMessage(err)}`, "error");
          return;
        }
        if (current.updatedAt > editedAt.current) {
          // Someone renamed it after our edit: theirs wins.
          dirty.current = false;
          setValue(current.title);
          qc.setQueryData<PageDetail>(qk.page(page.id), (p) => (p ? { ...p, ...current } : p));
          toast("The title was changed by someone else.");
          return;
        }
        revision = current.revision; // ours is newer: re-apply on the latest revision
      }
    }
  };

  if (!editable)
    return (
      <h1 className="page-title" id="page-title">
        {page.title || "Untitled"}
      </h1>
    );
  return (
    <>
      <h1 className="sr-only" id="page-title">
        {value || "Untitled"}
      </h1>
      <textarea
        ref={ref}
        rows={1}
        className="page-title page-title-input"
        aria-label="Page title"
        placeholder="Untitled"
        value={value}
        maxLength={500}
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, " ");
          setValue(v);
          dirty.current = true;
          editedAt.current = Date.now();
          clearTimeout(timer.current);
          if (!navigator.onLine) return;
          timer.current = setTimeout(() => void save(v), 500);
        }}
        onBlur={() => {
          if (dirty.current && navigator.onLine) {
            clearTimeout(timer.current);
            void save(value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            document.querySelector<HTMLElement>(".ws-doc")?.focus();
          }
        }}
      />
    </>
  );
}

const EMOJI = ["📄", "📝", "✅", "📌", "💡", "📚", "🚀", "⭐", "🗂", "📅", "🧪", "🎯"];

function IconField({ page, editable }: { page: PageDetail; editable: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(page.icon ?? "");
  const inputId = useId();
  const save = async (icon: string | null) => {
    const attempt = (revision: number) => api.updatePage(page.id, { expectedRevision: revision, icon });
    try {
      let r;
      try {
        r = await attempt(qc.getQueryData<PageDetail>(qk.page(page.id))?.revision ?? page.revision);
      } catch (err) {
        const current = conflictCurrent<PageSummary>(err);
        if (!current) throw err;
        r = await attempt(current.revision);
      }
      qc.setQueryData<PageDetail>(qk.page(page.id), (p) => (p ? { ...p, icon: r.page.icon, revision: r.page.revision } : p));
      invalidateListings(qc, page);
      setOpen(false);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  if (!editable) return page.icon ? <div className="page-icon" aria-hidden="true">{page.icon}</div> : null;
  return (
    <>
      <OnlineButton className={page.icon ? "page-icon page-icon-btn" : "btn btn-ghost btn-small add-icon"} aria-label={page.icon ? "Change icon" : "Add icon"} title={page.icon ? "Change icon" : "Add icon"} onClick={() => {
        setValue(page.icon ?? "");
        setOpen(true);
      }}>
        {page.icon || "☺ Add icon"}
      </OnlineButton>
      {open && (
        <Dialog
          title="Page icon"
          onClose={() => setOpen(false)}
          footer={
            <>
              {page.icon && (
                <button type="button" className="btn" onClick={() => void save(null)}>
                  Remove icon
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => void save(value.trim() || null)}>
                Save
              </button>
            </>
          }
        >
          <label className="field" htmlFor={inputId}>
            <span>Emoji or short text</span>
          </label>
          <input id={inputId} className="input" data-autofocus maxLength={16} value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="emoji-grid" role="group" aria-label="Suggestions">
            {EMOJI.map((e) => (
              <button key={e} type="button" className="icon-btn emoji" aria-label={`Use ${e}`} onClick={() => setValue(e)}>
                {e}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}

function CommentsPanel({ pageId, me, canComment, onClose }: { pageId: string; me: Me; canComment: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.comments(pageId), queryFn: () => api.comments(pageId) });
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const add = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      const { comment } = await api.addComment(pageId, text, newId("cm"));
      qc.setQueryData<{ comments: typeof comment[] }>(qk.comments(pageId), (d) => ({ comments: [...(d?.comments ?? []).filter((c) => c.id !== comment.id), comment] }));
      setBody("");
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (cid: string) => {
    try {
      await api.deleteComment(pageId, cid);
      qc.setQueryData<{ comments: { id: string }[] }>(qk.comments(pageId), (d) => (d ? { comments: d.comments.filter((c) => c.id !== cid) } : d));
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  return (
    <aside className="comments" aria-labelledby="comments-title">
      <div className="comments-head">
        <h2 id="comments-title">Comments</h2>
        <button type="button" className="icon-btn" aria-label="Close comments" onClick={onClose}>
          ×
        </button>
      </div>
      {q.isPending && <Spinner label="Loading comments" />}
      {q.isError && <p className="muted">{online ? errorMessage(q.error) : "Comments aren't available offline."}</p>}
      {q.data && q.data.comments.length === 0 && <p className="muted">No comments yet.</p>}
      <ul className="comment-list">
        {q.data?.comments.map((c) => (
          <li key={c.id} className="comment">
            <div className="comment-meta">
              <span className="avatar avatar-small" style={{ background: userColor(c.author.id) }} aria-hidden="true">
                {initials(c.author.name)}
              </span>
              <strong>{c.author.name}</strong>
              <time dateTime={new Date(c.createdAt).toISOString()} className="muted small">
                {relTime(c.createdAt)}
              </time>
              {c.author.id === me.user.id && (
                <OnlineButton className="btn-link small" aria-label={`Delete your comment from ${relTime(c.createdAt)}`} onClick={() => void remove(c.id)}>
                  Delete
                </OnlineButton>
              )}
            </div>
            <p className="comment-body">{c.body}</p>
          </li>
        ))}
      </ul>
      {canComment && (
        <form
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="sr-only" htmlFor="new-comment">
            Add a comment
          </label>
          <textarea id="new-comment" className="input" rows={3} placeholder="Add a comment…" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
          <OnlineButton type="submit" className="btn btn-primary btn-small" disabled={busy || !body.trim()}>
            Comment
          </OnlineButton>
        </form>
      )}
    </aside>
  );
}
