import type { PageSummary } from "@workspace/core";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, conflictCurrent, errorMessage } from "../api";
import { qk } from "../queries";
import { navigate } from "../router";
import { createStore, type Store, toast, useStore } from "../ui";

type Zone = "before" | "inside" | "after";
const DRAG_MIME = "application/x-ws-page";

export interface TreeProps {
  ws: string;
  label: string;
  /** nav: Enter/click opens the page; drag to reorder/nest. picker: Enter/click picks a target. */
  mode: "nav" | "picker";
  canWrite?: boolean;
  activeId?: string | null;
  onPick?: (page: PageSummary) => void;
  pickedId?: string | null;
  /** Hidden subtree (the page being moved can't become its own parent). */
  excludeId?: string;
  onAddChild?: (parentId: string) => void;
}

// Sidebar expansion survives navigation; pickers get their own.
const navExpanded = createStore<ReadonlySet<string>>(new Set());

export function useChildren(ws: string, parentId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.children(ws, parentId),
    queryFn: ({ pageParam }) => api.children(ws, parentId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function expandInSidebar(id: string) {
  const s = new Set(navExpanded.get());
  s.add(id);
  navExpanded.set(s);
}

export function PageTree(props: TreeProps) {
  const ref = useRef<HTMLUListElement>(null);
  const [pickerExpanded] = useState(() => createStore<ReadonlySet<string>>(new Set()));
  const expanded = props.mode === "nav" ? navExpanded : pickerExpanded;
  const focusId = useRef<string | null>(null);

  // Roving tabindex: exactly one treeitem is tabbable (last focused, else the active page, else the first).
  useEffect(() => {
    const ul = ref.current!;
    const sync = () => {
      const items = Array.from(ul.querySelectorAll<HTMLElement>('[role="treeitem"]'));
      const chosen =
        items.find((el) => el.dataset.id === focusId.current) ??
        items.find((el) => el.dataset.id && el.dataset.id === (props.pickedId ?? props.activeId)) ??
        items[0];
      for (const el of items) el.tabIndex = el === chosen ? 0 : -1;
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(ul, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [props.activeId, props.pickedId]);

  const setExpanded = (id: string, open: boolean) => {
    const s = new Set(expanded.get());
    if (open) s.add(id);
    else s.delete(id);
    expanded.set(s);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const ul = ref.current!;
    const cur = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!cur || (e.target as HTMLElement) !== cur) return;
    const items = Array.from(ul.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const i = items.indexOf(cur);
    const id = cur.dataset.id;
    const isOpen = cur.getAttribute("aria-expanded");
    const focus = (el: HTMLElement | undefined | null) => el?.focus();
    switch (e.key) {
      case "ArrowDown":
        focus(items[i + 1]);
        break;
      case "ArrowUp":
        focus(items[i - 1]);
        break;
      case "Home":
        focus(items[0]);
        break;
      case "End":
        focus(items.at(-1));
        break;
      case "ArrowRight":
        if (isOpen === "false" && id) setExpanded(id, true);
        else if (isOpen === "true") focus(cur.querySelector<HTMLElement>('[role="treeitem"]'));
        break;
      case "ArrowLeft":
        if (isOpen === "true" && id) setExpanded(id, false);
        else focus(cur.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case "Enter":
      case " ":
        cur.querySelector<HTMLElement>(":scope > .tree-row")?.click();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <ul
      ref={ref}
      role="tree"
      aria-label={props.label}
      className="tree"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const id = (e.target as HTMLElement).dataset.id;
        if (id) focusId.current = id;
      }}
    >
      <TreeLevel {...props} parentId={null} level={1} expanded={expanded} setExpanded={setExpanded} />
    </ul>
  );
}

interface LevelProps extends TreeProps {
  parentId: string | null;
  level: number;
  expanded: Store<ReadonlySet<string>>;
  setExpanded: (id: string, open: boolean) => void;
}

function TreeLevel(props: LevelProps) {
  const q = useChildren(props.ws, props.parentId);
  const pages = (q.data?.pages.flatMap((p) => p.pages) ?? []).filter((p) => p.id !== props.excludeId);
  if (q.isPending)
    return (
      <li role="treeitem" aria-level={props.level} aria-disabled="true" className="tree-note" data-id="">
        <div className="tree-row" style={{ paddingLeft: 8 + (props.level - 1) * 14 }}>
          Loading…
        </div>
      </li>
    );
  if (q.isError)
    return (
      <li role="treeitem" aria-level={props.level} aria-disabled="true" className="tree-note" data-id="">
        <div className="tree-row" style={{ paddingLeft: 8 + (props.level - 1) * 14 }}>
          {navigator.onLine ? `Couldn't load pages: ${errorMessage(q.error)}` : "Not available offline"}
        </div>
      </li>
    );
  if (!pages.length && props.level === 1)
    return (
      <li role="treeitem" aria-level={1} aria-disabled="true" className="tree-note" data-id="">
        <div className="tree-row">No pages yet</div>
      </li>
    );
  const total = pages.length + (q.hasNextPage ? 1 : 0);
  return (
    <>
      {pages.map((p, i) => (
        <TreeItem key={p.id} {...props} page={p} posinset={i + 1} setsize={total} prev={pages[i - 1] ?? null} first={pages[0] ?? null} />
      ))}
      {q.hasNextPage && (
        <li role="treeitem" aria-level={props.level} aria-posinset={total} aria-setsize={total} className="tree-more" data-id={`more:${props.parentId ?? "root"}`}>
          <div className="tree-row" style={{ paddingLeft: 8 + (props.level - 1) * 14 }} onClick={() => void q.fetchNextPage()}>
            {q.isFetchingNextPage ? "Loading…" : "Load more"}
          </div>
        </li>
      )}
    </>
  );
}

// Module-level: HTML5 drag data isn't readable during dragover.
let dragging: PageSummary | null = null;

function TreeItem(props: LevelProps & { page: PageSummary; posinset: number; setsize: number; prev: PageSummary | null; first: PageSummary | null }) {
  const { page, level } = props;
  const qc = useQueryClient();
  const expandedSet = useStore(props.expanded);
  const open = expandedSet.has(page.id);
  const [drop, setDrop] = useState<Zone | null>(null);
  const liRef = useRef<HTMLLIElement>(null);
  const nav = props.mode === "nav";
  const draggable = nav && !!props.canWrite;
  const selected = nav ? props.activeId === page.id : props.pickedId === page.id;
  const title = page.title || "Untitled";

  const activate = () => {
    if (nav) navigate(`/p/${page.id}`);
    else props.onPick?.(page);
  };

  const zoneOf = (e: DragEvent<HTMLElement>): Zone => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
  };

  const move = async (src: PageSummary, parentId: string | null, afterId?: string) => {
    try {
      await api.movePage(src.id, { expectedRevision: src.revision, parentId, afterId });
    } catch (err) {
      if (conflictCurrent(err)) toast("That page changed elsewhere. The sidebar was refreshed; try again.", "error");
      else toast(errorMessage(err), "error");
    } finally {
      for (const p of new Set([src.parentId, parentId])) void qc.invalidateQueries({ queryKey: qk.children(props.ws, p) });
      void qc.invalidateQueries({ queryKey: qk.page(src.id) });
    }
  };

  const onDrop = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDrop(null);
    const src = dragging;
    dragging = null;
    if (!src || src.id === page.id || !navigator.onLine) return;
    // Never into its own subtree (the server rejects cycles too).
    if (document.querySelector(`[role="treeitem"][data-id="${src.id}"]`)?.contains(liRef.current)) return;
    const zone = zoneOf(e);
    if (zone === "inside") {
      props.setExpanded(page.id, true);
      return move(src, page.id);
    }
    if (zone === "after") return move(src, page.parentId, page.id);
    if (props.prev) return props.prev.id === src.id ? undefined : move(src, page.parentId, props.prev.id);
    // shortcut: the API can only insert *after* a sibling; "before the first" = move after it, then move the old first after us.
    await move(src, page.parentId, page.id);
    await move(page, page.parentId, src.id);
  };

  return (
    <li
      ref={liRef}
      role="treeitem"
      aria-level={level}
      aria-posinset={props.posinset}
      aria-setsize={props.setsize}
      aria-expanded={page.hasChildren ? open : undefined}
      aria-selected={selected}
      aria-current={nav && selected ? "page" : undefined}
      aria-label={title}
      aria-disabled={!nav && page.id === props.excludeId ? true : undefined}
      data-id={page.id}
      className="tree-item"
    >
      <div
        className={`tree-row ${selected ? "is-active" : ""} ${drop ? `drop-${drop}` : ""}`}
        style={{ paddingLeft: 4 + (level - 1) * 14 }}
        onClick={activate}
        draggable={draggable}
        onDragStart={(e) => {
          dragging = page;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(DRAG_MIME, page.id);
        }}
        onDragEnd={() => (dragging = null)}
        onDragOver={(e) => {
          if (!dragging || !draggable || dragging.id === page.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDrop(zoneOf(e));
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => void onDrop(e)}
      >
        <span
          className={`tree-toggle ${page.hasChildren ? "" : "is-leaf"}`}
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            if (page.hasChildren) props.setExpanded(page.id, !open);
          }}
        >
          {page.hasChildren ? (open ? "▾" : "▸") : "•"}
        </span>
        <span className="tree-icon" aria-hidden="true">
          {page.icon || (page.isDatabase ? "▦" : "📄")}
        </span>
        <span className="tree-title">{title}</span>
        {nav && props.canWrite && props.onAddChild && (
          <button
            type="button"
            tabIndex={-1}
            className="tree-add icon-btn"
            aria-label={`Add a page inside ${title}`}
            title="Add a page inside"
            onClick={(e) => {
              e.stopPropagation();
              props.setExpanded(page.id, true);
              props.onAddChild?.(page.id);
            }}
          >
            +
          </button>
        )}
      </div>
      {open && page.hasChildren && (
        <ul role="group">
          <TreeLevel {...props} parentId={page.id} level={level + 1} />
        </ul>
      )}
    </li>
  );
}
