import type { PropertyDef, PropertyType, PropertyValue, RecordRow, SelectOption } from "@workspace/core";
import { type InfiniteData, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, conflictCurrent, errorMessage } from "../api";
import { qk } from "../queries";
import { Link } from "../router";
import { OFFLINE_REASON, Spinner, toast, useOnline } from "../ui";

export type RowsPage = { records: RecordRow[]; nextCursor: string | null; schemaRevision: number };

export const TYPE_LABEL: Record<PropertyType, string> = {
  title: "Title",
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Select",
  status: "Status",
  checkbox: "Checkbox",
  url: "URL",
};
export const TYPE_ICON: Record<PropertyType, string> = { title: "Aa", text: "≡", number: "#", date: "◷", select: "▾", status: "◉", checkbox: "☑", url: "↗" };
export const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

/** Put a fresh record into every cache that holds it (table pages, board columns, record header). */
export function applyRecord(qc: QueryClient, databaseId: string, rec: RecordRow) {
  qc.setQueryData(qk.record(rec.id), rec);
  qc.setQueriesData<InfiniteData<RowsPage>>({ queryKey: qk.rows(databaseId) }, (data) =>
    data?.pages ? { ...data, pages: data.pages.map((p) => ({ ...p, records: p.records.map((r) => (r.id === rec.id ? rec : r)) })) } : data,
  );
}

const same = (a: PropertyValue | undefined, b: PropertyValue | undefined) => (a ?? null) === (b ?? null);

export function formatDate(v: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", ...(v.length > 10 ? { hour: "2-digit", minute: "2-digit" } : {}) });
}

export function displayText(def: PropertyDef, v: PropertyValue | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  if (def.type === "select" || def.type === "status") return def.options?.find((o) => o.id === v)?.name ?? "";
  if (def.type === "checkbox") return v ? "Checked" : "Unchecked";
  if (def.type === "date") return formatDate(String(v));
  return String(v);
}

export function Pill({ option, status }: { option: SelectOption; status?: boolean }) {
  return (
    <span className={`pill pill-${option.color}`}>
      {status && <span className="status-dot" aria-hidden="true" />}
      {option.name}
    </span>
  );
}

function Value({ def, value }: { def: PropertyDef; value: PropertyValue | undefined }) {
  if ((def.type === "select" || def.type === "status") && value) {
    const o = def.options?.find((x) => x.id === value);
    return o ? <Pill option={o} status={def.type === "status"} /> : null;
  }
  const text = displayText(def, value);
  return text ? <span className="cell-text">{text}</span> : null;
}

/** Parse what was typed into the stored value; `undefined` = invalid (keep editing). */
function parseInput(def: PropertyDef, raw: string): PropertyValue | undefined {
  const v = raw.trim();
  if (def.type === "title") return raw.slice(0, 500);
  if (!v) return null;
  if (def.type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (def.type === "url") return /^(https?:\/\/|mailto:)/i.test(v) ? v : `https://${v}`;
  return v;
}

export interface CellProps {
  record: RecordRow;
  def: PropertyDef;
  databaseId: string;
  editable: boolean;
  /** Start in edit mode (a row that was just added). */
  autoEdit?: boolean;
  onEditEnd?: () => void;
}

/**
 * One property value: shows it, edits it inline, and saves with the record revision. On a 409 where
 * someone changed *this* property, shows their value and lets the user re-apply theirs; changes to
 * other properties are merged by retrying on the latest revision.
 */
export function Cell({ record, def, databaseId, editable, autoEdit, onEditEnd }: CellProps) {
  const qc = useQueryClient();
  const online = useOnline();
  const [editing, setEditing] = useState(!!autoEdit && editable);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ mine: PropertyValue; current: RecordRow } | null>(null);
  // Checkbox shows the new state while saving; cleared (= server value) when the save settles.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const value = record.values[def.id] ?? null;
  const text = displayText(def, value);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      btn.current?.focus({ preventScroll: true });
    }
  }, [editing]);

  const stop = (focusCell: boolean) => {
    refocus.current = focusCell;
    setEditing(false);
    onEditEnd?.();
  };

  const save = async (next: PropertyValue, base: RecordRow = record) => {
    const before = base.values[def.id] ?? null;
    if (same(next, before)) return setConflict(null);
    setSaving(true);
    let revision = base.revision;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { record: saved } = await api.updateRecord(record.id, revision, { [def.id]: next });
          applyRecord(qc, databaseId, saved);
          if (def.type === "title") void qc.invalidateQueries({ queryKey: qk.page(record.id), exact: true });
          setConflict(null);
          return;
        } catch (err) {
          const current = conflictCurrent<RecordRow>(err);
          if (!current) throw err;
          applyRecord(qc, databaseId, current);
          if (!same(current.values[def.id], before)) {
            setConflict({ mine: next, current });
            return;
          }
          revision = current.revision; // a different property changed: re-apply ours on top
        }
      }
      toast("Not saved: this row keeps changing. Try again.", "error");
    } catch (err) {
      toast(`Not saved: ${errorMessage(err)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const begin = () => {
    if (!navigator.onLine) return toast(OFFLINE_REASON);
    setEditing(true);
  };

  const label = `${def.name}: ${text || (def.type === "title" ? "Untitled" : "Empty")}`;
  const conflictBox = conflict && (
    <div className="cell-conflict" role="alert">
      <p>
        Someone else changed {def.name} to “{displayText(def, conflict.current.values[def.id]) || "empty"}”. Yours (“{displayText(def, conflict.mine) || "empty"}”) wasn't saved.
      </p>
      <div className="row">
        <button type="button" className="btn btn-small btn-primary" onClick={() => void save(conflict.mine, conflict.current)}>
          Save mine
        </button>
        <button type="button" className="btn btn-small" onClick={() => setConflict(null)}>
          Keep theirs
        </button>
      </div>
    </div>
  );

  if (def.type === "checkbox") {
    return (
      <div className={`cell cell-check ${saving ? "cell-saving" : ""}`}>
        <input
          type="checkbox"
          checked={optimistic ?? !!value}
          disabled={!editable}
          aria-disabled={editable && !online ? true : undefined}
          aria-label={def.name}
          title={editable && !online ? OFFLINE_REASON : undefined}
          onChange={(e) => {
            if (!navigator.onLine) return toast(OFFLINE_REASON);
            setOptimistic(e.target.checked);
            void save(e.target.checked).finally(() => setOptimistic(null));
          }}
        />
        {conflictBox}
      </div>
    );
  }

  const open =
    def.type === "title" ? (
      <Link className="cell-open" to={`/p/${record.id}`} aria-label={`Open ${record.title || "Untitled"}`}>
        Open
      </Link>
    ) : def.type === "url" && value ? (
      <a className="cell-open" href={String(value)} target="_blank" rel="noopener noreferrer" aria-label={`Open link ${String(value)}`}>
        ↗
      </a>
    ) : null;

  if (editing) {
    if (def.type === "select" || def.type === "status") {
      return (
        <div className="cell">
          <select
            className="cell-input"
            autoFocus
            aria-label={def.name}
            defaultValue={String(value ?? "")}
            onChange={(e) => {
              stop(true);
              void save(e.target.value || null);
            }}
            onBlur={() => stop(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                stop(true);
              }
            }}
          >
            <option value="">Empty</option>
            {def.options?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      );
    }
    return (
      <div className="cell">
        <CellInput
          def={def}
          initial={value === null ? "" : String(value)}
          onCommit={(raw, focusCell) => {
            const next = parseInput(def, raw);
            if (next === undefined) {
              toast(`“${raw}” isn't a valid ${def.type}.`, "error");
              return false;
            }
            stop(focusCell);
            void save(next);
            return true;
          }}
          onCancel={() => stop(true)}
        />
      </div>
    );
  }

  return (
    <div className={`cell ${saving ? "cell-saving" : ""}`}>
      {editable ? (
        <button
          ref={btn}
          type="button"
          className={`cell-btn ${online ? "" : "is-disabled"}`}
          aria-label={label}
          aria-disabled={online ? undefined : true}
          title={online ? undefined : OFFLINE_REASON}
          onClick={begin}
        >
          {def.type === "title" ? <span className="cell-text">{record.title || <span className="cell-empty">Untitled</span>}</span> : <Value def={def} value={value} />}
        </button>
      ) : def.type === "title" ? (
        <div className="cell-static">
          <Link to={`/p/${record.id}`} className="cell-text">
            {record.title || "Untitled"}
          </Link>
        </div>
      ) : def.type === "url" && value ? (
        <div className="cell-static">
          <a href={String(value)} target="_blank" rel="noopener noreferrer" className="cell-text">
            {String(value)}
          </a>
        </div>
      ) : (
        <div className="cell-static">
          <Value def={def} value={value} />
        </div>
      )}
      {editable && open}
      {conflictBox}
    </div>
  );
}

function CellInput({ def, initial, onCommit, onCancel }: { def: PropertyDef; initial: string; onCommit: (raw: string, focusCell: boolean) => boolean; onCancel: () => void }) {
  // Enter commits, then the unmount blur must not commit a second time.
  const finished = useRef(false);
  const commit = (raw: string, focusCell: boolean) => {
    if (!finished.current) finished.current = onCommit(raw, focusCell);
  };
  const type = def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "url" ? "url" : "text";
  return (
    <input
      className="cell-input"
      autoFocus
      type={type}
      step={def.type === "number" ? "any" : undefined}
      aria-label={def.name}
      defaultValue={def.type === "date" ? initial.slice(0, 10) : initial}
      onBlur={(e) => commit(e.currentTarget.value, false)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finished.current = true;
          onCancel();
        }
      }}
    />
  );
}

export const useDatabase = (id: string) => useQuery({ queryKey: qk.database(id), queryFn: () => api.database(id).then((r) => r.database) });

/** Editable properties header shown above a database record's document. */
export function RecordProperties({ recordId, databaseId, editable }: { recordId: string; databaseId: string; editable: boolean }) {
  const db = useDatabase(databaseId);
  const rec = useQuery({ queryKey: qk.record(recordId), queryFn: () => api.record(recordId).then((r) => r.record) });
  const online = useOnline();
  if (!db.data || !rec.data) {
    if (db.isError || rec.isError || !online) return <p className="muted small">Properties aren't available {online ? "right now" : "offline"}.</p>;
    return <Spinner label="Loading properties" />;
  }
  const props = db.data.schema.filter((p) => p.type !== "title");
  if (!props.length) return null;
  return (
    <dl className="props" aria-label="Properties">
      {props.map((def) => (
        <Fragment key={def.id}>
          <dt>
            <span className="type-icon" aria-hidden="true">
              {TYPE_ICON[def.type]}
            </span>
            {def.name}
          </dt>
          <dd>
            <Cell record={rec.data} def={def} databaseId={databaseId} editable={editable} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
