import { ApiRequestError, can, type HierarchyNode, type Me, newId } from "@workspace/core";
import { hierarchyEdgePath, layoutHierarchy } from "@workspace/core/hierarchy";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileText, Focus, ListTree, Minus, Network, Plus, Search, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import { qk, roleIn } from "../queries";
import { navigate, setSearchParam, useLocation } from "../router";
import { MoveDialog } from "../shell/dialogs";
import { createPageIn, TopBar } from "../shell/Shell";
import { OnlineButton, toast, useDebounced, useOnline } from "../ui";

const terminal = (error: unknown) => error instanceof ApiRequestError && [401, 403, 404].includes(error.status);

/** Each expanded branch owns one paginated metadata query. Document bodies never enter the graph. */
function Branch({ ws, parentId, report }: { ws: string; parentId: string | null; report: (parent: string | null, nodes: HierarchyNode[]) => void }) {
  const q = useInfiniteQuery({ queryKey: qk.hierarchy(ws, parentId), queryFn: ({ pageParam }) => api.hierarchy(ws, { parentId, cursor: pageParam, limit: 100 }), initialPageParam: null as string | null, getNextPageParam: (last) => last.nextCursor });
  useEffect(() => { if (terminal(q.error)) report(parentId, []); else if (q.data) report(parentId, q.data.pages.flatMap((p) => p.nodes)); }, [q.data, q.error, report, parentId]);
  if (q.isPending) return <span className="muted small" role="status">Loading branch…</span>;
  if (q.isError) return <button className="btn btn-small" onClick={() => void q.refetch()}>Retry branch: {errorMessage(q.error)}</button>;
  return q.hasNextPage ? <button className="btn btn-small" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : `Load more ${parentId ? "in branch" : "workspace pages"}`}</button> : null;
}

export default function Graph({ ws, me }: { ws: string; me: Me }) {
  const qc = useQueryClient();
  const { search } = useLocation();
  const focusId = search.get("focus");
  const online = useOnline();
  const title = me.workspaces.find((w) => w.id === ws)?.name ?? "Workspace";
  const writable = can(roleIn(me, ws), "write");
  const rootId = `workspace:${ws}`;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [branches, setBranches] = useState<Record<string, HierarchyNode[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [treeView, setTreeView] = useState(false);
  const [term, setTerm] = useState("");
  const query = useDebounced(term.trim(), 250);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const [camera, setCamera] = useState({ x: 24, y: 24, scale: 1 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const focusQ = useQuery({ queryKey: ["hierarchy", ws, "focus", focusId], queryFn: () => api.hierarchy(ws, { focusId: focusId! }), enabled: !!focusId });
  const focusPath = useMemo(() => terminal(focusQ.error) ? [] : focusQ.data?.path ?? [], [focusQ.data, focusQ.error]);
  const searchQ = useQuery({ queryKey: ["search", ws, query], queryFn: () => api.search(ws, query), enabled: !!query && online });
  const report = useCallback((parent: string | null, nodes: HierarchyNode[]) => setBranches((prev) => ({ ...prev, [parent ?? "root"]: nodes })), []);
  useEffect(() => {
    document.title = `Graph · ${title}`;
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [title, treeView]);
  useEffect(() => {
    if (!focusPath.length) return;
    setExpanded((prev) => new Set([...prev, ...focusPath.slice(0, -1).map((p) => p.id)]));
    setSelected(focusId);
  }, [focusPath, focusId]);
  // Only retain active branches. A collapse removes its descendants from both layout and subscriptions.
  const activeParents = useMemo(() => {
    const result: (string | null)[] = [null];
    const visit = (parent: string | null, seen = new Set<string>()) => {
      for (const n of branches[parent ?? "root"] ?? []) if (expanded.has(n.id) && !seen.has(n.id)) { seen.add(n.id); result.push(n.id); visit(n.id, seen); }
    };
    visit(null);
    for (const p of focusPath) if (expanded.has(p.id) && !result.includes(p.id)) result.push(p.id);
    return result;
  }, [branches, expanded, focusPath]);
  const nodes = useMemo(() => [...(focusPath), ...activeParents.flatMap((p) => branches[p ?? "root"] ?? [])], [branches, activeParents, focusPath]);
  const layout = useMemo(() => layoutHierarchy(nodes, expanded, { rootId, rootTitle: title }), [nodes, expanded, rootId, title]);
  useEffect(() => { if (selected && !layout.nodes.some((n) => n.id === selected)) setSelected(null); }, [layout, selected]);
  const current = layout.nodes.find((n) => n.id === selected)?.node ?? null;
  useEffect(() => {
    const node = layout.nodes.find((n) => n.id === selected);
    if (!node) return;
    // Opening the inspector narrows the canvas; keep the selected node within the new bounds.
    setCamera((prev) => {
      const left = prev.x + node.x * prev.scale, right = left + node.width * prev.scale;
      const top = prev.y + node.y * prev.scale, bottom = top + node.height * prev.scale;
      const dx = left < 20 ? 20 - left : right > size.width - 20 ? size.width - 20 - right : 0;
      const dy = top < 20 ? 20 - top : bottom > size.height - 20 ? size.height - 20 - bottom : 0;
      return dx || dy ? { ...prev,x:prev.x + dx,y:prev.y + dy } : prev;
    });
  }, [layout, selected, size]);

  const fit = useCallback(() => { const scale = Math.max(.0001, Math.min(1, (size.width - 64) / layout.width, (size.height - 64) / layout.height)); setCamera({ scale, x: (size.width - layout.width * scale) / 2, y: (size.height - layout.height * scale) / 2 }); }, [size, layout]);
  const focused = layout.nodes.find((n) => n.id === focusId);
  const focusX = focused?.x, focusY = focused?.y;
  useEffect(() => { if (focusX !== undefined && focusY !== undefined) setCamera({ scale: 1, x: size.width / 2 - focusX - 104, y: size.height / 2 - focusY - 26 }); }, [focusId, focusX, focusY, size]);
  const toggle = (id: string) => setExpanded((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const zoom = (factor: number, x = size.width / 2, y = size.height / 2) => setCamera((prev) => { const scale = Math.min(2, Math.max(.0001, prev.scale * factor)); return { scale, x: x - (x - prev.x) * scale / prev.scale, y: y - (y - prev.y) * scale / prev.scale }; });
  const createRecord = async () => { if (!current) return; try { const id = newId("pg"); await api.createRecord(current.id, {}, id); void qc.invalidateQueries({ queryKey: ["hierarchy", ws] }); navigate(`/p/${id}?new=1`); } catch (err) { toast(errorMessage(err), "error"); } };
  const selectFromSearch = (id: string) => { setSearchParam("focus", id); setTerm(""); };
  return <>
    <TopBar><span className="crumb-current">Graph</span><span className="muted small">{title}</span></TopBar>
    <div className="graph-page">
      <div className="graph-toolbar">
        <div className="graph-search"><Search size={16} aria-hidden="true" /><input aria-label="Find a page in Graph" placeholder="Find a page…" value={term} onChange={(e) => setTerm(e.target.value)} />
          {query && <div className="graph-results" aria-label="Graph search results">{!online ? <p>Search needs a connection.</p> : searchQ.isFetching ? <p>Searching…</p> : searchQ.isError ? <p>{errorMessage(searchQ.error)}</p> : searchQ.data?.results.length ? searchQ.data.results.map((hit) => <button key={hit.pageId} onClick={() => selectFromSearch(hit.pageId)}>{hit.title || "Untitled"}</button>) : <p>No results.</p>}</div>}
        </div>
        <button className="btn btn-small" aria-pressed={treeView} onClick={() => setTreeView((v) => !v)}><ListTree size={16} />{treeView ? "Map view" : "Tree view"}</button>
        <button className="icon-btn" aria-label="Zoom out" onClick={() => zoom(.8)}><Minus size={18} /></button>
        <span className="graph-zoom">{camera.scale < .01 ? (camera.scale * 100).toFixed(2) : Math.round(camera.scale * 100)}%</span>
        <button className="icon-btn" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={18} /></button>
        <button className="btn btn-small" onClick={fit}><Focus size={16} />Fit</button>
      </div>
      {!online && <div className="banner banner-info">Offline. Showing saved hierarchy. Creating and moving pages need a connection.</div>}
      {focusQ.isError && <div className="banner banner-error">{errorMessage(focusQ.error)}</div>}
      <div className="graph-body">
        <div ref={viewport} className="graph-viewport" aria-label="Workspace hierarchy map" onWheel={(e) => { if (!treeView) { const r = e.currentTarget.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.1 : .9, e.clientX - r.left, e.clientY - r.top); } }}>
          {treeView ? <div role="tree" aria-label="Workspace hierarchy" className="graph-tree" onKeyDown={(e) => { const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')); const i = items.indexOf(e.target as HTMLElement); if (i < 0) return; const cur = layout.nodes[i]!; const isOpen = cur.id === rootId || expanded.has(cur.id);
              if (e.key === "ArrowDown") items[i + 1]?.focus();
              else if (e.key === "ArrowUp") items[i - 1]?.focus();
              else if (e.key === "Home") items[0]?.focus();
              else if (e.key === "End") items.at(-1)?.focus();
              else if (e.key === "ArrowRight") { if (cur.node?.hasChildren && !isOpen) toggle(cur.id); else if (layout.nodes[i + 1]?.depth === cur.depth + 1) items[i + 1]?.focus(); }
              else if (e.key === "ArrowLeft") { if (cur.node?.hasChildren && isOpen) toggle(cur.id); else { const parent = layout.nodes.slice(0, i).findLastIndex((n) => n.depth === cur.depth - 1); if (parent >= 0) items[parent]?.focus(); } }
              else return; e.preventDefault(); }}>
            {layout.nodes.map((n) => <div key={n.id} role="treeitem" tabIndex={n.id === selected || (!selected && n.id === rootId) ? 0 : -1} data-id={n.id} aria-level={n.depth + 1} aria-selected={selected === n.id} aria-expanded={n.node?.hasChildren ? expanded.has(n.id) : undefined} className={`graph-tree-row ${selected === n.id ? "is-active" : ""}`} style={{ paddingLeft: 12 + n.depth * 24 }} onFocus={() => setSelected(n.id)} onClick={() => setSelected(n.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(n.id); } }}>
              {n.node?.hasChildren && <button className="icon-btn" aria-label={`${expanded.has(n.id) ? "Collapse" : "Expand"} ${n.node.title || "Untitled"}`} onClick={() => toggle(n.id)}>{expanded.has(n.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>}
              {n.node?.icon || (n.node?.isDatabase ? <Table2 size={16} /> : n.node ? <FileText size={16} /> : <Network size={16} />)}<span>{n.node ? n.node.title || "Untitled" : title}</span><span className="tag">{n.node?.kind ?? "workspace"}</span>
            </div>)}
          </div> : <svg width="100%" height="100%" role="group" aria-label="Pan the map by dragging its background. Select nodes to open or move pages." onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y }; }} onPointerMove={(e) => { if (drag.current) setCamera((p) => ({ ...p, x:drag.current!.cx + e.clientX - drag.current!.x,y:drag.current!.cy + e.clientY - drag.current!.y })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <g transform={`translate(${camera.x},${camera.y}) scale(${camera.scale})`}>
              {layout.edges.map((edge) => <path key={edge.id} d={hierarchyEdgePath(edge)} className="graph-edge" />)}
              {layout.nodes.map((n) => <g key={n.id} transform={`translate(${n.x},${n.y})`} role="group" aria-label={`${n.node ? n.node.title || "Untitled" : title}, ${n.node?.kind ?? "workspace"}`} onPointerDown={(e) => e.stopPropagation()} className={`graph-node ${selected === n.id ? "is-selected" : ""}`}><g role="button" tabIndex={0} aria-label={`Select ${n.node ? n.node.title || "Untitled" : title}`} aria-pressed={selected === n.id} onClick={() => setSelected(n.id)} onDoubleClick={() => n.node && navigate(`/p/${n.id}`)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(n.id); } }}>
                <rect width={n.width} height={n.height} rx={6} /><foreignObject x={12} y={0} width={n.width - 38} height={n.height}><div className="graph-node-label">{n.node?.icon || (n.node?.isDatabase ? <Table2 size={18} /> : n.node ? <FileText size={18} /> : <Network size={18} />)}<span>{n.node ? n.node.title || "Untitled" : title}</span></div></foreignObject></g>
                {n.node?.hasChildren && <g role="button" tabIndex={0} aria-label={`${expanded.has(n.id) ? "Collapse" : "Expand"} ${n.node.title || "Untitled"}`} onClick={(e) => { e.stopPropagation(); toggle(n.id); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(n.id); } }}><rect x={n.width - 29} y={15} width={22} height={22} rx={4} /><text x={n.width - 18} y={31} textAnchor="middle">{expanded.has(n.id) ? "−" : "+"}</text></g>}
              </g>)}
            </g>
          </svg>}
        </div>
        {selected && <aside className="graph-inspector" aria-label="Selected node"><strong>{current ? current.title || "Untitled" : title}</strong><span className="muted small">{current?.kind ?? "Workspace"}</span>{current && <button className="btn" onClick={() => navigate(`/p/${current.id}`)}>Open</button>}{writable && (!current || !current.isDatabase) && <OnlineButton className="btn" onClick={() => void createPageIn(qc, ws, current?.id ?? null)}>New {current ? "subpage" : "page"}</OnlineButton>}{writable && current?.isDatabase && <OnlineButton className="btn" onClick={() => void createRecord()}>New record</OnlineButton>}{writable && current && !current.databaseId && <OnlineButton className="btn" onClick={() => setMoving(true)}>Move to…</OnlineButton>}{current?.databaseId && <p className="muted small">This record belongs to its database. Its subpages can move to other pages.</p>}<button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button></aside>}
      </div>
      <div className="graph-branch-status">{activeParents.map((parent) => <Branch key={parent ?? "root"} ws={ws} parentId={parent} report={report} />)}{layout.nodes.length === 1 && <span className="muted small">Create a page to start your workspace hierarchy.</span>}</div>
    </div>
    {moving && current && <MoveDialog page={current} onClose={() => setMoving(false)} />}
  </>;
}
