import {
  type DatabaseInfo,
  FILTER_OPS,
  type Filter,
  newId,
  type PropertyDef,
  type PropertyType,
  PROPERTY_TYPES,
  type RecordRow,
  type SelectOption,
  type Sort,
  type ViewConfig,
  type ViewInfo,
} from "@workspace/core";
import { type QueryClient, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { api, conflictCurrent, errorMessage, fileSafe } from "../api";
import { qk } from "../queries";
import { Link, setSearchParam, useLocation } from "../router";
import { ConfirmDialog, Dialog, Menu, OnlineButton, Spinner, toast } from "../ui";
import { applyRecord, Cell, COLORS, displayText, Pill, type RowsPage, TYPE_ICON, TYPE_LABEL, useDatabase } from "./cells";

const PAGE_SIZE = 50;
const ROW_HEIGHT = 35;
const OP_LABEL: Record<string, string> = {
  contains: "contains",
  not_contains: "does not contain",
  equals: "is exactly",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  on: "is on",
  before: "is before",
  after: "is after",
  is: "is",
  is_not: "is not",
};
const NO_VALUE_OPS = new Set(["is_empty", "is_not_empty"]);
const isGroupable = (p: PropertyDef) => p.type === "select" || p.type === "status";

/** Drop filters/sorts that point at deleted properties (the server would reject the whole query). */
function liveConfig(db: DatabaseInfo, c: ViewConfig): ViewConfig {
  const has = (id: string) => db.schema.some((p) => p.id === id);
  return { ...c, filters: c.filters.filter((f) => has(f.propId)), sorts: c.sorts.filter((s) => s.propId === "created_at" || has(s.propId)), hiddenProps: c.hiddenProps.filter(has) };
}

async function saveView(qc: QueryClient, db: DatabaseInfo, view: ViewInfo, input: { config?: ViewConfig; name?: string }): Promise<boolean> {
  const put = (next: ViewInfo) => qc.setQueryData<DatabaseInfo>(qk.database(db.id), (d) => (d ? { ...d, views: d.views.map((v) => (v.id === next.id ? next : v)) } : d));
  try {
    const { view: next } = await api.updateView(db.id, view.id, { expectedRevision: view.revision, ...input });
    put(next);
    return true;
  } catch (err) {
    const current = conflictCurrent<ViewInfo>(err);
    if (current) {
      put(current);
      toast("Someone else changed this view. Review it and try again.", "error");
    } else toast(errorMessage(err), "error");
    return false;
  }
}

async function saveSchema(qc: QueryClient, db: DatabaseInfo, schema: PropertyDef[]): Promise<boolean> {
  try {
    const { database } = await api.updateSchema(db.id, db.revision, schema);
    qc.setQueryData(qk.database(db.id), database);
    void qc.invalidateQueries({ queryKey: qk.rows(db.id) });
    return true;
  } catch (err) {
    const current = conflictCurrent<DatabaseInfo>(err);
    if (current) {
      qc.setQueryData(qk.database(db.id), current);
      toast("Someone else changed the properties. Your change wasn't applied; try again.", "error");
    } else toast(errorMessage(err), "error");
    return false;
  }
}

/** Set one property on a record (board moves); retries when only other properties changed. */
async function setValue(qc: QueryClient, db: DatabaseInfo, rec: RecordRow, propId: string, value: string | null) {
  let base = rec;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { record } = await api.updateRecord(rec.id, base.revision, { [propId]: value });
      applyRecord(qc, db.id, record);
      break;
    } catch (err) {
      const current = conflictCurrent<RecordRow>(err);
      if (!current || (current.values[propId] ?? null) !== (rec.values[propId] ?? null)) {
        toast(current ? "Someone else moved this card first. The board was refreshed." : errorMessage(err), "error");
        break;
      }
      base = current;
    }
  }
  void qc.invalidateQueries({ queryKey: qk.rows(db.id) });
}

export default function DatabaseView({ id, canWrite }: { id: string; ws: string; canWrite: boolean }) {
  const q = useDatabase(id);
  const { search } = useLocation();
  const [dialog, setDialog] = useState<"filter" | "sort" | "props" | null>(null);
  const [autoEdit, setAutoEdit] = useState<string | null>(null);
  const qc = useQueryClient();
  const db = q.data;

  if (!db) {
    if (q.isError || q.fetchStatus === "paused")
      return <p className="db-empty">{q.isError ? `Couldn't load this database: ${errorMessage(q.error)}` : "This database isn't available offline yet."}</p>;
    return <Spinner label="Loading database" />;
  }
  const view = db.views.find((v) => v.id === search.get("view")) ?? db.views[0];
  if (!view) return <p className="db-empty">This database has no views.</p>;
  const config = liveConfig(db, view.config);

  const addRow = async (values: Record<string, string | null> = {}) => {
    const rid = newId("pg");
    try {
      await api.createRecord(db.id, values, rid);
      setAutoEdit(rid);
      await qc.invalidateQueries({ queryKey: qk.rows(db.id) });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const exportCsv = () => {
    const a = document.createElement("a");
    a.href = api.exportCsvUrl(db.id);
    a.download = `${fileSafe(db.title)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const summary = (kind: "filter" | "sort") => {
    if (kind === "filter")
      return config.filters
        .map((f) => {
          const def = db.schema.find((p) => p.id === f.propId)!;
          return `${def.name} ${OP_LABEL[f.op] ?? f.op}${NO_VALUE_OPS.has(f.op) ? "" : ` ${filterValueText(def, f.value)}`}`;
        })
        .join("; ");
    return config.sorts.map((s) => `${s.propId === "created_at" ? "Created time" : db.schema.find((p) => p.id === s.propId)!.name} ${s.direction === "asc" ? "↑" : "↓"}`).join(", ");
  };

  return (
    <section className="db" aria-label={`Database ${db.title || "Untitled"}`}>
      <ViewTabs db={db} view={view} canWrite={canWrite} />
      <div role="tabpanel" id="db-view-panel" aria-labelledby={`tab-${view.id}`}>
        <div className="db-toolbar">
          {canWrite ? (
            <>
              <button type="button" className="btn btn-small btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("filter")}>
                Filter{config.filters.length ? ` (${config.filters.length})` : ""}
              </button>
              <button type="button" className="btn btn-small btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("sort")}>
                Sort{config.sorts.length ? ` (${config.sorts.length})` : ""}
              </button>
              {view.type === "board" && <GroupBySelect db={db} view={view} config={config} />}
              <button type="button" className="btn btn-small btn-ghost" aria-haspopup="dialog" onClick={() => setDialog("props")}>
                Properties
              </button>
            </>
          ) : (
            <span className="count">
              {config.filters.length ? `Filtered: ${summary("filter")}. ` : ""}
              {config.sorts.length ? `Sorted: ${summary("sort")}.` : ""}
            </span>
          )}
          <span className="spacer" />
          <OnlineButton className="btn btn-small btn-ghost" onClick={exportCsv}>
            Export CSV
          </OnlineButton>
          {canWrite && (
            <OnlineButton className="btn btn-small btn-primary" onClick={() => void addRow()}>
              New
            </OnlineButton>
          )}
        </div>
        {canWrite && config.filters.length > 0 && <p className="muted small">Filtered: {summary("filter")}</p>}
        {view.type === "board" ? (
          <Board db={db} view={view} config={config} canWrite={canWrite} addRow={addRow} />
        ) : (
          <Table db={db} view={view} config={config} canWrite={canWrite} addRow={addRow} autoEdit={autoEdit} clearAutoEdit={() => setAutoEdit(null)} onEditProps={() => setDialog("props")} />
        )}
      </div>
      {dialog === "filter" && <FilterDialog db={db} view={view} config={config} onClose={() => setDialog(null)} />}
      {dialog === "sort" && <SortDialog db={db} view={view} config={config} onClose={() => setDialog(null)} />}
      {dialog === "props" && <PropertiesDialog db={db} onClose={() => setDialog(null)} />}
    </section>
  );
}

function filterValueText(def: PropertyDef, v: Filter["value"]): string {
  if (def.type === "checkbox") return v ? "checked" : "unchecked";
  return `“${displayText(def, v ?? null) || String(v ?? "")}”`;
}

// ---------- view tabs ----------

function ViewTabs({ db, view, canWrite }: { db: DatabaseInfo; view: ViewInfo; canWrite: boolean }) {
  const qc = useQueryClient();
  const group = db.schema.find(isGroupable);
  const select = (v: ViewInfo) => setSearchParam("view", v.id === db.views[0]?.id ? null : v.id);
  const create = async (type: "table" | "board") => {
    const n = db.views.filter((v) => v.type === type).length + 1;
    try {
      const { view: created } = await api.createView(db.id, {
        name: `${type === "board" ? "Board" : "Table"} ${n}`,
        type,
        config: { filters: [], sorts: [], groupBy: type === "board" ? (group?.id ?? null) : null, hiddenProps: [] },
      });
      qc.setQueryData<DatabaseInfo>(qk.database(db.id), (d) => (d ? { ...d, views: [...d.views, created] } : d));
      setSearchParam("view", created.id);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  };
  return (
    <div className="db-tabs">
      <div role="tablist" aria-label="Views" className="row" onKeyDown={onKey}>
        {db.views.map((v) => (
          <button
            key={v.id}
            id={`tab-${v.id}`}
            type="button"
            role="tab"
            className="db-tab"
            aria-selected={v.id === view.id}
            aria-controls="db-view-panel"
            tabIndex={v.id === view.id ? 0 : -1}
            onClick={() => select(v)}
          >
            <span aria-hidden="true">{v.type === "board" ? "▥ " : "▤ "}</span>
            {v.name}
          </button>
        ))}
      </div>
      {canWrite && (
        <Menu
          label="Add a view"
          align="left"
          items={[
            { label: "Table view", onSelect: () => void create("table"), disabledReason: navigator.onLine ? null : "Needs a connection" },
            {
              label: "Board view",
              onSelect: () => void create("board"),
              disabledReason: !group ? "Add a select or status property first" : navigator.onLine ? null : "Needs a connection",
            },
          ]}
        >
          ＋
        </Menu>
      )}
    </div>
  );
}

function GroupBySelect({ db, view, config }: { db: DatabaseInfo; view: ViewInfo; config: ViewConfig }) {
  const qc = useQueryClient();
  const id = useId();
  const options = db.schema.filter(isGroupable);
  return (
    <span className="row gap">
      <label htmlFor={id} className="small muted">
        Group by
      </label>
      <select
        id={id}
        className="select btn-small"
        value={config.groupBy && options.some((o) => o.id === config.groupBy) ? config.groupBy : ""}
        onChange={(e) => e.target.value && void saveView(qc, db, view, { config: { ...config, groupBy: e.target.value } })}
      >
        <option value="" disabled>
          Choose…
        </option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </span>
  );
}

// ---------- table ----------

function useRows(db: DatabaseInfo, view: ViewInfo, config: ViewConfig, extra: Filter[] = [], key: unknown[] = []) {
  return useInfiniteQuery({
    queryKey: qk.rows(db.id, view.id, config, ...key),
    queryFn: ({ pageParam }) => api.query(db.id, { filters: [...config.filters, ...extra], sorts: config.sorts, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: RowsPage) => last.nextCursor,
  });
}

function Table(props: {
  db: DatabaseInfo;
  view: ViewInfo;
  config: ViewConfig;
  canWrite: boolean;
  addRow: () => Promise<void>;
  autoEdit: string | null;
  clearAutoEdit: () => void;
  onEditProps: () => void;
}) {
  const { db, view, config, canWrite } = props;
  const qc = useQueryClient();
  const q = useRows(db, view, config);
  const rows = q.data?.pages.flatMap((p) => p.records) ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = [...db.schema].sort((a, b) => (a.type === "title" ? -1 : b.type === "title" ? 1 : 0)).filter((p) => !config.hiddenProps.includes(p.id));
  const count = rows.length + (q.hasNextPage ? 1 : 0);
  const virtualizer = useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });
  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);

  useEffect(() => {
    if (last && last.index >= rows.length - 1 && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [last?.index, rows.length, q.hasNextPage, q.isFetchingNextPage, q]);

  const autoIndex = props.autoEdit ? rows.findIndex((r) => r.id === props.autoEdit) : -1;
  useEffect(() => {
    if (autoIndex >= 0) virtualizer.scrollToIndex(autoIndex, { align: "auto" });
  }, [autoIndex, virtualizer]);

  const sortBy = (propId: string, direction: "asc" | "desc") => void saveView(qc, db, view, { config: { ...config, sorts: [{ propId, direction }] } });
  const padTop = items[0]?.start ?? 0;
  const padBottom = virtualizer.getTotalSize() - (last?.end ?? 0);

  if (q.isError) return <p className="db-empty">{navigator.onLine ? `Couldn't load rows: ${errorMessage(q.error)}` : "These rows aren't available offline."}</p>;

  return (
    <>
      <div className="table-scroll" ref={scrollRef}>
        <table className="db-table" aria-label={`${db.title || "Untitled"}: ${view.name}`} aria-rowcount={q.hasNextPage ? -1 : rows.length + 1}>
          <thead>
            <tr aria-rowindex={1}>
              {cols.map((def) => (
                <th key={def.id} scope="col" className={def.type === "title" ? "col-title" : ""}>
                  {canWrite ? (
                    <Menu
                      label={def.name}
                      labelledByContent
                      buttonClassName="th-btn"
                      align="left"
                      items={[
                        { label: "Sort ascending", onSelect: () => sortBy(def.id, "asc"), disabledReason: navigator.onLine ? null : "Needs a connection" },
                        { label: "Sort descending", onSelect: () => sortBy(def.id, "desc"), disabledReason: navigator.onLine ? null : "Needs a connection" },
                        { label: "Edit properties…", onSelect: props.onEditProps },
                      ]}
                    >
                      <span className="type-icon" aria-hidden="true">
                        {TYPE_ICON[def.type]}
                      </span>
                      <span className="cell-text">{def.name}</span>
                    </Menu>
                  ) : (
                    <span className="th-static">
                      <span className="type-icon" aria-hidden="true">
                        {TYPE_ICON[def.type]}
                      </span>
                      {def.name}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={cols.length} style={{ height: padTop, padding: 0, border: "none" }} />
              </tr>
            )}
            {items.map((vi) => {
              const r = rows[vi.index];
              if (!r)
                return (
                  <tr key="loader" className="loader-row" data-index={vi.index} ref={virtualizer.measureElement}>
                    <td colSpan={cols.length}>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                        {q.isFetchingNextPage ? "Loading more…" : "Load more"}
                      </button>
                    </td>
                  </tr>
                );
              return (
                <tr key={r.id} data-index={vi.index} ref={virtualizer.measureElement} aria-rowindex={vi.index + 2}>
                  {cols.map((def) => (
                    <td key={def.id} className={def.type === "title" ? "col-title" : ""}>
                      <Cell
                        record={r}
                        def={def}
                        databaseId={db.id}
                        editable={canWrite}
                        autoEdit={def.type === "title" && r.id === props.autoEdit}
                        onEditEnd={r.id === props.autoEdit ? props.clearAutoEdit : undefined}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td colSpan={cols.length} style={{ height: padBottom, padding: 0, border: "none" }} />
              </tr>
            )}
          </tbody>
        </table>
        {q.isPending && <Spinner label="Loading rows" />}
        {q.isSuccess && rows.length === 0 && <p className="db-empty">{config.filters.length ? "No rows match these filters." : "No rows yet."}</p>}
      </div>
      {canWrite && (
        <OnlineButton className="add-row" onClick={() => void props.addRow()}>
          <span aria-hidden="true">＋</span> New row
        </OnlineButton>
      )}
    </>
  );
}

// ---------- board ----------

interface Column {
  key: string;
  option: SelectOption | null;
}

function Board({ db, view, config, canWrite, addRow }: { db: DatabaseInfo; view: ViewInfo; config: ViewConfig; canWrite: boolean; addRow: (v: Record<string, string | null>) => Promise<void> }) {
  const dragging = useRef<RecordRow | null>(null);
  const group = db.schema.find((p) => p.id === config.groupBy && isGroupable(p));
  if (!group) return <p className="db-empty">Boards group cards by a select or status property. {canWrite ? "Choose one in “Group by”." : "Ask an editor to choose one."}</p>;
  const columns: Column[] = [...(group.options ?? []).map((o) => ({ key: o.id, option: o })), { key: "none", option: null }];
  return (
    <div className="board">
      {columns.map((c) => (
        <BoardColumn key={c.key} db={db} view={view} config={config} group={group} column={c} columns={columns} canWrite={canWrite} dragging={dragging} addRow={addRow} />
      ))}
    </div>
  );
}

function BoardColumn(props: {
  db: DatabaseInfo;
  view: ViewInfo;
  config: ViewConfig;
  group: PropertyDef;
  column: Column;
  columns: Column[];
  canWrite: boolean;
  dragging: RefObject<RecordRow | null>;
  addRow: (v: Record<string, string | null>) => Promise<void>;
}) {
  const { db, view, config, group, column, canWrite, dragging } = props;
  const qc = useQueryClient();
  const headingId = useId();
  const [over, setOver] = useState(false);
  const optionId = column.option?.id ?? null;
  const filter: Filter = optionId ? { propId: group.id, op: "is", value: optionId } : { propId: group.id, op: "is_empty" };
  const q = useRows(db, view, config, [filter], ["col", column.key]);
  const records = q.data?.pages.flatMap((p) => p.records) ?? [];
  const name = column.option?.name ?? `No ${group.name}`;
  const move = (r: RecordRow, to: string | null) => {
    if ((r.values[group.id] ?? null) === to) return;
    if (!navigator.onLine) return toast("You're offline. Moving cards needs a connection.");
    void setValue(qc, db, r, group.id, to);
  };

  return (
    <section
      className={`board-col ${over ? "is-over" : ""}`}
      aria-labelledby={headingId}
      onDragOver={(e) => {
        if (!canWrite || !dragging.current) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const r = dragging.current;
        dragging.current = null;
        if (r) move(r, optionId);
      }}
    >
      <h3 id={headingId}>
        {column.option ? <Pill option={column.option} status={group.type === "status"} /> : <span className="muted">{name}</span>}
        <span className="count">
          {records.length}
          {q.hasNextPage ? "+" : ""}
        </span>
      </h3>
      {q.isPending && <Spinner label={`Loading ${name}`} />}
      {q.isError && <p className="muted small">{navigator.onLine ? errorMessage(q.error) : "Not available offline."}</p>}
      <ul className="board-cards" aria-labelledby={headingId}>
        {records.map((r) => (
          <li
            key={r.id}
            className="card"
            draggable={canWrite}
            data-record={r.id}
            onDragStart={(e) => {
              dragging.current = r;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", r.id);
              e.currentTarget.classList.add("is-dragging");
            }}
            onDragEnd={(e) => {
              dragging.current = null;
              e.currentTarget.classList.remove("is-dragging");
            }}
          >
            <div className="grow">
              <Link to={`/p/${r.id}`}>{r.title || "Untitled"}</Link>
              <CardProps db={db} record={r} skip={group.id} />
            </div>
            {canWrite && (
              <Menu
                label={`Move “${r.title || "Untitled"}” to column`}
                items={props.columns
                  .filter((c) => c.key !== column.key)
                  .map((c) => ({ label: `Move to ${c.option?.name ?? `No ${group.name}`}`, onSelect: () => move(r, c.option?.id ?? null), disabledReason: navigator.onLine ? null : "Needs a connection" }))}
              >
                ⋯
              </Menu>
            )}
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
      {canWrite && (
        <OnlineButton className="add-row" aria-label={`New card in ${name}`} onClick={() => void props.addRow({ [group.id]: optionId })}>
          <span aria-hidden="true">＋</span> New
        </OnlineButton>
      )}
    </section>
  );
}

function CardProps({ db, record, skip }: { db: DatabaseInfo; record: RecordRow; skip: string }) {
  const shown = db.schema.filter((p) => p.type !== "title" && p.id !== skip && p.type !== "checkbox" && displayText(p, record.values[p.id]));
  if (!shown.length) return null;
  return (
    <div className="card-props">
      {shown.slice(0, 4).map((p) => {
        const v = record.values[p.id];
        const o = isGroupable(p) ? p.options?.find((x) => x.id === v) : undefined;
        return o ? <Pill key={p.id} option={o} status={p.type === "status"} /> : <span key={p.id} className="small muted">{displayText(p, v)}</span>;
      })}
    </div>
  );
}

// ---------- filter & sort dialogs ----------

function defaultFilter(def: PropertyDef): Filter {
  const op = FILTER_OPS[def.type][0];
  const value = def.type === "checkbox" ? true : isGroupable(def) ? (def.options?.[0]?.id ?? "") : "";
  return { propId: def.id, op, value };
}

function validFilter(db: DatabaseInfo, f: Filter): Filter | null {
  const def = db.schema.find((p) => p.id === f.propId);
  if (!def) return null;
  if (NO_VALUE_OPS.has(f.op)) return { propId: f.propId, op: f.op };
  if (def.type === "checkbox") return { ...f, value: f.value === true || f.value === "true" };
  if (def.type === "number") {
    const n = typeof f.value === "number" ? f.value : Number(String(f.value ?? "").trim() || NaN);
    return Number.isFinite(n) ? { ...f, value: n } : null;
  }
  const s = String(f.value ?? "").trim();
  return s ? { ...f, value: s } : null;
}

function FilterDialog({ db, view, config, onClose }: { db: DatabaseInfo; view: ViewInfo; config: ViewConfig; onClose: () => void }) {
  const qc = useQueryClient();
  const [rules, setRules] = useState<Filter[]>(config.filters);
  const [busy, setBusy] = useState(false);
  const set = (i: number, f: Filter) => setRules(rules.map((r, j) => (j === i ? f : r)));
  const save = async () => {
    const valid = rules.map((r) => validFilter(db, r));
    if (valid.some((v) => !v)) return toast("Fill in a value for every filter, or remove it.", "error");
    setBusy(true);
    if (await saveView(qc, db, view, { config: { ...config, filters: valid as Filter[] } })) onClose();
    setBusy(false);
  };
  return (
    <Dialog
      title={`Filters for ${view.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <OnlineButton className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Save filters
          </OnlineButton>
        </>
      }
    >
      {rules.length === 0 && <p className="muted">No filters. Every row is shown.</p>}
      <ul className="rule-list">
        {rules.map((f, i) => {
          const def = db.schema.find((p) => p.id === f.propId) ?? db.schema[0]!;
          return (
            <li key={i} className="rule">
              <select className="select" aria-label={`Filter ${i + 1} property`} value={def.id} onChange={(e) => set(i, defaultFilter(db.schema.find((p) => p.id === e.target.value)!))}>
                {db.schema.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select className="select" aria-label={`Filter ${i + 1} condition`} value={f.op} onChange={(e) => set(i, { ...f, op: e.target.value })}>
                {FILTER_OPS[def.type].map((op) => (
                  <option key={op} value={op}>
                    {OP_LABEL[op] ?? op}
                  </option>
                ))}
              </select>
              {!NO_VALUE_OPS.has(f.op) && <FilterValue def={def} filter={f} index={i} onChange={(value) => set(i, { ...f, value })} />}
              <button type="button" className="icon-btn" aria-label={`Remove filter ${i + 1}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-small" disabled={rules.length >= 10} onClick={() => setRules([...rules, defaultFilter(db.schema[0]!)])}>
        ＋ Add filter
      </button>
    </Dialog>
  );
}

function FilterValue({ def, filter, index, onChange }: { def: PropertyDef; filter: Filter; index: number; onChange: (v: Filter["value"]) => void }) {
  const label = `Filter ${index + 1} value`;
  if (def.type === "checkbox")
    return (
      <select className="select" aria-label={label} value={String(filter.value === true || filter.value === "true")} onChange={(e) => onChange(e.target.value === "true")}>
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  if (isGroupable(def))
    return (
      <select className="select" aria-label={label} value={String(filter.value ?? "")} onChange={(e) => onChange(e.target.value)}>
        {(def.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  return (
    <input
      className="input"
      aria-label={label}
      type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
      value={filter.value === null || filter.value === undefined ? "" : String(filter.value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function SortDialog({ db, view, config, onClose }: { db: DatabaseInfo; view: ViewInfo; config: ViewConfig; onClose: () => void }) {
  const qc = useQueryClient();
  const [sorts, setSorts] = useState<Sort[]>(config.sorts);
  const [busy, setBusy] = useState(false);
  const fields = [...db.schema.map((p) => ({ id: p.id, name: p.name })), { id: "created_at", name: "Created time" }];
  const set = (i: number, s: Sort) => setSorts(sorts.map((x, j) => (j === i ? s : x)));
  const save = async () => {
    setBusy(true);
    if (await saveView(qc, db, view, { config: { ...config, sorts } })) onClose();
    setBusy(false);
  };
  return (
    <Dialog
      title={`Sort ${view.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <OnlineButton className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Save sorts
          </OnlineButton>
        </>
      }
    >
      {sorts.length === 0 && <p className="muted">Rows are in the order they were created.</p>}
      <ol className="rule-list">
        {sorts.map((s, i) => (
          <li key={i} className="rule">
            <select className="select" aria-label={`Sort ${i + 1} property`} value={s.propId} onChange={(e) => set(i, { ...s, propId: e.target.value })}>
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select className="select" aria-label={`Sort ${i + 1} direction`} value={s.direction} onChange={(e) => set(i, { ...s, direction: e.target.value as Sort["direction"] })}>
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button type="button" className="icon-btn" aria-label={`Remove sort ${i + 1}`} onClick={() => setSorts(sorts.filter((_, j) => j !== i))}>
              ×
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-small" disabled={sorts.length >= 3} onClick={() => setSorts([...sorts, { propId: db.schema[0]!.id, direction: "asc" }])}>
        ＋ Add sort
      </button>
      {sorts.length >= 3 && <p className="muted small">Up to 3 sorts per view.</p>}
    </Dialog>
  );
}

// ---------- properties ----------

function PropertiesDialog({ db, onClose }: { db: DatabaseInfo; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [confirm, setConfirm] = useState<PropertyDef | null>(null);
  const nameId = useId();
  const typeId = useId();
  const update = (def: PropertyDef) => saveSchema(qc, db, db.schema.map((p) => (p.id === def.id ? def : p)));
  const retype = (def: PropertyDef, t: PropertyType) => {
    const options = t === "select" || t === "status" ? (def.options?.length ? def.options : t === "status" ? [{ id: newId("o", 12), name: "Not started", color: "gray" as const }] : []) : undefined;
    void update({ id: def.id, name: def.name, type: t, ...(options ? { options } : {}) });
  };
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    const def: PropertyDef = { id: newId("p", 12), name: n.slice(0, 100), type, ...(type === "status" ? { options: [{ id: newId("o", 12), name: "Not started", color: "gray" }] } : type === "select" ? { options: [] } : {}) };
    if (await saveSchema(qc, db, [...db.schema, def])) setName("");
  };

  return (
    <Dialog title="Properties" wide onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <ul className="prop-list">
        {db.schema.map((def) => (
          <li key={`${def.id}-${db.revision}`} className="prop-item">
            <div className="row">
              <span className="type-icon" aria-hidden="true">
                {TYPE_ICON[def.type]}
              </span>
              <input
                className="input"
                aria-label={`Name of property ${def.name}`}
                defaultValue={def.name}
                maxLength={100}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== def.name) void update({ ...def, name: v });
                  else e.target.value = def.name;
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              {def.type === "title" ? (
                <span className="tag">Title</span>
              ) : (
                <>
                  <select className="select" aria-label={`Type of ${def.name}`} value={def.type} onChange={(e) => retype(def, e.target.value as PropertyType)}>
                    {PROPERTY_TYPES.filter((t) => t !== "title").map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirm(def)}>
                    Delete
                  </button>
                </>
              )}
            </div>
            {isGroupable(def) && <OptionsEditor def={def} onChange={(d) => void update(d)} />}
          </li>
        ))}
      </ul>
      <h3 className="section-title">Add a property</h3>
      <form
        className="row gap wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <label htmlFor={nameId} className="sr-only">
          New property name
        </label>
        <input id={nameId} className="input grow" placeholder="Property name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <label htmlFor={typeId} className="sr-only">
          New property type
        </label>
        <select id={typeId} className="select" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
          {PROPERTY_TYPES.filter((t) => t !== "title").map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <OnlineButton type="submit" className="btn btn-primary" disabled={!name.trim() || db.schema.length >= 50}>
          Add property
        </OnlineButton>
      </form>
      {confirm && (
        <ConfirmDialog
          title={`Delete “${confirm.name}”?`}
          message="Its values are removed from every row. Views that filter, sort or group by it stop doing so."
          confirm="Delete property"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const target = confirm;
            setConfirm(null);
            void saveSchema(
              qc,
              db,
              db.schema.filter((p) => p.id !== target.id),
            );
          }}
        />
      )}
    </Dialog>
  );
}

function OptionsEditor({ def, onChange }: { def: PropertyDef; onChange: (d: PropertyDef) => void }) {
  const [name, setName] = useState("");
  const options = def.options ?? [];
  const put = (next: SelectOption[]) => onChange({ ...def, options: next });
  const addId = useId();
  return (
    <div>
      <ul className="option-list" aria-label={`Options of ${def.name}`}>
        {options.map((o) => (
          <li key={o.id}>
            <Pill option={o} status={def.type === "status"} />
            <input
              className="input"
              style={{ width: 160 }}
              aria-label={`Rename option ${o.name}`}
              defaultValue={o.name}
              maxLength={100}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== o.name) put(options.map((x) => (x.id === o.id ? { ...x, name: v } : x)));
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <select className="select" aria-label={`Color of ${o.name}`} value={o.color} onChange={(e) => put(options.map((x) => (x.id === o.id ? { ...x, color: e.target.value as SelectOption["color"] } : x)))}>
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove option ${o.name}`}
              disabled={def.type === "status" && options.length <= 1}
              title={def.type === "status" && options.length <= 1 ? "A status needs at least one option" : undefined}
              onClick={() => put(options.filter((x) => x.id !== o.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row gap"
        style={{ marginTop: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n || options.length >= 100) return;
          put([...options, { id: newId("o", 12), name: n.slice(0, 100), color: COLORS[options.length % COLORS.length]! }]);
          setName("");
        }}
      >
        <label htmlFor={addId} className="sr-only">
          New option for {def.name}
        </label>
        <input id={addId} className="input" style={{ width: 200 }} placeholder="Add an option" value={name} onChange={(e) => setName(e.target.value)} />
        <OnlineButton type="submit" className="btn btn-small" disabled={!name.trim()}>
          Add option
        </OnlineButton>
      </form>
    </div>
  );
}
