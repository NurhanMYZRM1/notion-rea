import { ChevronDown, ChevronsLeft, FileText, Home as HomeIcon, Network, PanelLeft, Plus, Search, Settings, Table2, Trash2, Ellipsis } from "lucide-react";
import { can, type Me, newId, type PageSummary } from "@workspace/core";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, type CSSProperties, type ReactNode, Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, errorMessage } from "../api";
import { createSubpage } from "../subpages";
import { useWorkspaceEvents } from "../events";
import { lastWorkspace, qk, rememberWorkspace, roleIn } from "../queries";
import { Link, match, navigate, useLocation } from "../router";
import { createStore, Menu, OnlineButton, Splash, toast, useStore } from "../ui";
import { ImportDialog } from "./dialogs";
import { expandInSidebar, PageTree } from "./PageTree";
import { SearchDialog } from "./SearchDialog";

const PageView = lazy(() => import("../pages/PageView"));
const SettingsPage = lazy(() => import("../pages/Settings"));
const GraphPage = lazy(() => import("../pages/Graph"));
const TrashPage = lazy(() => import("../pages/Trash"));

// ---------- sidebar state ----------

const COLLAPSED_KEY = "ws-sidebar-collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};
const sidebar = createStore({ collapsed: readCollapsed(), drawerOpen: false });
const mq = window.matchMedia("(max-width: 767px)");
const useNarrow = () =>
  useSyncExternalStore(
    (l) => {
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    () => mq.matches,
  );

function toggleSidebar(narrow: boolean) {
  const s = sidebar.get();
  if (narrow) sidebar.set({ ...s, drawerOpen: !s.drawerOpen });
  else {
    try {
      localStorage.setItem(COLLAPSED_KEY, s.collapsed ? "0" : "1");
    } catch {
      /* private mode: not remembered */
    }
    sidebar.set({ ...s, collapsed: !s.collapsed });
  }
}
const closeDrawer = () => {
  if (sidebar.get().drawerOpen) sidebar.set({ ...sidebar.get(), drawerOpen: false });
};

/** Every view renders its own top bar; the sidebar toggle lives here. */
export function TopBar({ children }: { children?: ReactNode }) {
  const narrow = useNarrow();
  const s = useStore(sidebar);
  const shown = narrow ? s.drawerOpen : !s.collapsed;
  return (
    <header className="topbar">
      {(narrow || s.collapsed) && (
        <button
          type="button"
          className="icon-btn sidebar-toggle"
          aria-label={shown ? "Hide sidebar" : "Show sidebar"}
          title={shown ? "Hide sidebar" : "Show sidebar"}
          aria-expanded={shown}
          aria-controls="sidebar"
          onClick={() => toggleSidebar(narrow)}
        >
          <PanelLeft size={18} />
        </button>
      )}
      {children}
    </header>
  );
}

// ---------- actions ----------

export async function createPageIn(qc: QueryClient, ws: string, parentId: string | null) {
  try {
    let id: string;
    if (parentId) id = (await createSubpage(parentId)).page.id;
    else { id = newId("pg"); await api.createPage(ws, { id, parentId }); }
    void qc.invalidateQueries({ queryKey: ["hierarchy", ws] });
    await qc.invalidateQueries({ queryKey: qk.children(ws, parentId) });
    if (parentId) {
      expandInSidebar(parentId);
      void qc.invalidateQueries({ queryKey: qk.page(parentId) });
    }
    navigate(`/p/${id}?new=1`);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

async function createDatabaseIn(qc: QueryClient, ws: string) {
  try {
    const id = newId("pg");
    await api.createDatabase(ws, { id, parentId: null, title: "Untitled database" });
    await qc.invalidateQueries({ queryKey: qk.children(ws, null) });
    navigate(`/p/${id}?new=1`);
  } catch (err) {
    toast(errorMessage(err), "error");
  }
}

// ---------- shell ----------

export function Shell({ me }: { me: Me }) {
  const { pathname } = useLocation();
  const narrow = useNarrow();
  const s = useStore(sidebar);
  const wsRoute = match(/^\/w\/([^/]+)(?:\/(trash|settings|graph))?\/?$/, pathname);
  const pageId = match(/^\/p\/([^/]+)\/?$/, pathname)?.[0] ?? null;
  const pageQ = usePageMaybe(pageId);
  const last = lastWorkspace();
  const fallbackWs = me.workspaces.some((w) => w.id === last) ? last! : (me.workspaces[0]?.id ?? null);
  const ws = wsRoute?.[0] ?? pageQ?.workspaceId ?? fallbackWs ?? "";
  const member = me.workspaces.find((w) => w.id === ws);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.max(200, Math.min(400, Number(localStorage.getItem("ws-sidebar-width")) || 240)));
  const resizeSidebar = (width: number) => { const next = Math.round(Math.max(200, Math.min(400, width))); setSidebarWidth(next); localStorage.setItem("ws-sidebar-width", String(next)); };

  useWorkspaceEvents(member ? ws : null);
  useEffect(() => {
    if (member) rememberWorkspace(ws);
  }, [member, ws]);
  useEffect(() => {
    if ((pathname === "/" || pathname === "") && fallbackWs) navigate(`/w/${fallbackWs}`, { replace: true });
  }, [pathname, fallbackWs]);
  useEffect(closeDrawer, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sidebarShown = narrow ? s.drawerOpen : !s.collapsed;
  let content: ReactNode;
  if (wsRoute && !member) content = <Missing title="Workspace not found" text="You're not a member of this workspace, or it no longer exists." />;
  else if (wsRoute?.[1] === "trash") content = <TrashPage ws={ws} me={me} />;
  else if (wsRoute?.[1] === "settings") content = <SettingsPage ws={ws} me={me} />;
  else if (wsRoute?.[1] === "graph") content = <GraphPage key={ws} ws={ws} me={me} />;
  else if (wsRoute) content = <Home ws={ws} me={me} />;
  else if (pageId) content = <PageView key={pageId} id={pageId} me={me} />;
  else if (pathname === "/") content = <Splash />;
  else content = <Missing title="Page not found" text="There's nothing at this address." />;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className={`app ${sidebarShown ? "has-sidebar" : ""} ${narrow ? "is-narrow" : ""}`} style={{ "--sidebar-w": `${sidebarWidth}px` } as CSSProperties}>
        {sidebarShown && member && <Sidebar me={me} ws={ws} activeId={pageId} onSearch={() => setSearchOpen(true)} narrow={narrow} />}
        {sidebarShown && !narrow && member && <div className="sidebar-resizer" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={400} aria-valuenow={sidebarWidth} tabIndex={0} onKeyDown={(e) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); resizeSidebar(e.key === "Home" ? 200 : e.key === "End" ? 400 : sidebarWidth + (e.key === "ArrowRight" ? 10 : -10)); } }} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resizeSidebar(e.clientX); }} />}
        {narrow && s.drawerOpen && <div className="drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />}
        <div className="main-col">
          <main id="main" tabIndex={-1}>
            <Suspense fallback={<Splash />}>{content}</Suspense>
          </main>
        </div>
      </div>
      {searchOpen && member && <SearchDialog ws={ws} onClose={() => setSearchOpen(false)} />}
    </>
  );
}

function usePageMaybe(id: string | null) {
  const q = useQuery({ queryKey: qk.page(id ?? ""), queryFn: () => api.page(id!).then((r) => r.page), enabled: !!id });
  return id ? q.data : undefined;
}

function Missing({ title, text }: { title: string; text: string }) {
  return (
    <>
      <TopBar />
      <div className="center-card">
        <h1>{title}</h1>
        <p className="muted">{text}</p>
        <Link to="/" className="btn">
          Go home
        </Link>
      </div>
    </>
  );
}

function Sidebar({ me, ws, activeId, onSearch, narrow }: { me: Me; ws: string; activeId: string | null; onSearch: () => void; narrow: boolean }) {
  const qc = useQueryClient();
  const role = roleIn(me, ws);
  const canWrite = can(role, "write");
  const current = me.workspaces.find((w) => w.id === ws)!;
  const [importKind, setImportKind] = useState<"markdown" | "csv" | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

  useEffect(() => {
    if (!narrow) return;
    navRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        closeDrawer();
        document.querySelector<HTMLElement>(".sidebar-toggle")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow]);

  return (
    <nav ref={navRef} id="sidebar" className={`sidebar ${narrow ? "is-drawer" : ""}`} aria-label="Sidebar">
      <div className="sidebar-top">
        <Menu
          label={`Workspace: ${current.name}. Switch workspace`}
          buttonClassName="ws-switcher"
          align="left"
          items={me.workspaces.map((w) => ({ label: `${w.name}${w.id === ws ? " ✓" : ""}`, onSelect: () => navigate(`/w/${w.id}`) }))}
        >
          <span className="ws-badge" aria-hidden="true">
            {current.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="ws-name">{current.name}</span>
          <span aria-hidden="true" className="chev">
            <ChevronDown size={14} />
          </span>
        </Menu>
        <button
          type="button"
          className="icon-btn"
          aria-label="Hide sidebar"
          title="Hide sidebar"
          aria-expanded="true"
          aria-controls="sidebar"
          onClick={() => toggleSidebar(narrow)}
        >
          <ChevronsLeft size={18} />
        </button>
      </div>
      <div className="sidebar-actions">
        <button type="button" className="side-btn" onClick={onSearch}>
          <Search size={17} aria-hidden="true" /> Search <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <Link to={`/w/${ws}`} className="side-btn" aria-current={location.pathname === `/w/${ws}` ? "page" : undefined}>
          <HomeIcon size={17} aria-hidden="true" /> Home
        </Link>
        <Link to={`/w/${ws}/graph`} className="side-btn" aria-current={location.pathname.endsWith("/graph") ? "page" : undefined}><Network size={17} aria-hidden="true" /> Graph</Link>
        {canWrite && (
          <div className="row">
            <OnlineButton className="side-btn grow" offlineReason="You're offline. New pages need a connection." onClick={() => void createPageIn(qc, ws, null)}>
              <Plus size={17} aria-hidden="true" /> New page
            </OnlineButton>
            <Menu
              label="More ways to add"
              items={[
                { label: "New database", onSelect: () => void createDatabaseIn(qc, ws), disabledReason: navigator.onLine ? null : "Needs a connection" },
                { label: "Import Markdown…", onSelect: () => setImportKind("markdown"), disabledReason: navigator.onLine ? null : "Needs a connection" },
                { label: "Import CSV…", onSelect: () => setImportKind("csv"), disabledReason: navigator.onLine ? null : "Needs a connection" },
              ]}
            >
              <Ellipsis size={18} />
            </Menu>
          </div>
        )}
      </div>
      <div className="sidebar-scroll">
        <PinnedList title="Favorites" ws={ws} kind="favorites" activeId={activeId} />
        <PinnedList title="Recents" ws={ws} kind="recents" activeId={activeId} limit={5} />
        <section aria-labelledby="pages-heading" className="side-section">
          <h2 id="pages-heading" className="side-heading">
            Pages
          </h2>
          <PageTree ws={ws} label="Pages" mode="nav" canWrite={canWrite} activeId={activeId} onAddChild={(id) => void createPageIn(qc, ws, id)} />
        </section>
      </div>
      <div className="sidebar-foot">
        <Link to={`/w/${ws}/trash`} className="side-btn" aria-current={location.pathname.endsWith("/trash") ? "page" : undefined}>
          <Trash2 size={17} aria-hidden="true" /> Trash
        </Link>
        <Link to={`/w/${ws}/settings`} className="side-btn" aria-current={location.pathname.endsWith("/settings") ? "page" : undefined}>
          <Settings size={17} aria-hidden="true" /> Settings
        </Link>
        <div className="side-user" title={me.user.email}>
          <span className="avatar" style={{ background: "var(--accent)" }} aria-hidden="true">
            {(me.user.name || me.user.email).slice(0, 1).toUpperCase()}
          </span>
          <span className="side-user-email">{me.user.email}</span>
        </div>
      </div>
      {importKind && <ImportDialog ws={ws} kind={importKind} onClose={() => setImportKind(null)} />}
    </nav>
  );
}

function PinnedList({ title, ws, kind, activeId, limit }: { title: string; ws: string; kind: "favorites" | "recents"; activeId: string | null; limit?: number }) {
  const q = useQuery({ queryKey: kind === "favorites" ? qk.favorites(ws) : qk.recents(ws), queryFn: () => (kind === "favorites" ? api.favorites(ws) : api.recents(ws)) });
  const pages = (q.data?.pages ?? []).slice(0, limit ?? 50);
  if (!pages.length) return null;
  const id = `${kind}-heading`;
  return (
    <section aria-labelledby={id} className="side-section">
      <h2 id={id} className="side-heading">
        {title}
      </h2>
      <ul className="pinned">
        {pages.map((p) => (
          <li key={p.id}>
            <PageLink page={p} active={p.id === activeId} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PageLink({ page, active }: { page: Pick<PageSummary, "id" | "title" | "icon" | "isDatabase">; active?: boolean }) {
  return (
    <Link to={`/p/${page.id}`} className={`page-link ${active ? "is-active" : ""}`} aria-current={active ? "page" : undefined}>
      <span aria-hidden="true" className="tree-icon">
        {page.icon || (page.isDatabase ? <Table2 size={16} /> : <FileText size={16} />)}
      </span>
      <span className="tree-title">{page.title || "Untitled"}</span>
    </Link>
  );
}

function Home({ ws, me }: { ws: string; me: Me }) {
  const qc = useQueryClient();
  const recents = useQuery({ queryKey: qk.recents(ws), queryFn: () => api.recents(ws) });
  const current = me.workspaces.find((w) => w.id === ws)!;
  useEffect(() => {
    document.title = `${current.name} · Workspace`;
  }, [current.name]);
  return (
    <>
      <TopBar>
        <span className="crumb-current">{current.name}</span>
      </TopBar>
      <div className="doc">
        <h1 className="home-title">{current.name}</h1>
        <p className="muted">
          You're {current.role === "owner" ? "an owner" : current.role === "editor" ? "an editor" : "a viewer"} in this workspace.
        </p>
        <h2 className="section-title">Recently visited</h2>
        {recents.data?.pages.length ? (
          <ul className="card-list">
            {recents.data.pages.slice(0, 12).map((p) => (
              <li key={p.id}>
                <PageLink page={p} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Pages you open will show up here.</p>
        )}
        {can(current.role, "write") && (
          <OnlineButton className="btn btn-primary" offlineReason="You're offline. New pages need a connection." onClick={() => void createPageIn(qc, ws, null)}>
            New page
          </OnlineButton>
        )}
      </div>
    </>
  );
}

