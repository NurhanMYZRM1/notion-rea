import {
  CreateDatabaseInput,
  CreateRecordInput,
  CreateViewInput,
  type DatabaseInfo,
  FILTER_OPS,
  type Filter,
  newId,
  parseCsv,
  type PropertyDef,
  type PropertyValue,
  QueryRecordsInput,
  type RecordRow,
  type Sort,
  toCsv,
  UpdateRecordInput,
  UpdateSchemaInput,
  UpdateViewInput,
  type ViewConfig,
  type ViewInfo,
} from "@workspace/core";
import { AppError, conflict, notFound } from "../errors";
import { pageUrl } from "../util";
import { type Actor, audit, requireAccess, requirePageAccess } from "./access";
import { createPage, publish } from "./pages";

const DEFAULT_SCHEMA = (): PropertyDef[] => [
  { id: "p_title", name: "Name", type: "title" },
  {
    id: "p_status",
    name: "Status",
    type: "status",
    options: [
      { id: "o_todo", name: "Not started", color: "gray" },
      { id: "o_doing", name: "In progress", color: "blue" },
      { id: "o_done", name: "Done", color: "green" },
    ],
  },
];

const EMPTY_VIEW: ViewConfig = { filters: [], sorts: [], groupBy: null, hiddenProps: [] };

interface DbRow {
  page_id: string;
  workspace_id: string;
  schema: string;
  revision: number;
  title: string;
  state: string;
}

async function loadDb(env: Env, actor: Actor, databaseId: string, capability: "read" | "write") {
  const access = await requirePageAccess(env, actor, databaseId, capability);
  const db = await env.DB.prepare(
    "SELECT d.page_id, d.workspace_id, d.schema, d.revision, p.title, p.state FROM databases d JOIN pages p ON p.id = d.page_id WHERE d.page_id = ?",
  )
    .bind(databaseId)
    .first<DbRow>();
  if (!db) throw notFound("Database");
  if (capability === "write" && db.state !== "active") throw conflict("Database is in the trash; restore it first");
  return { access, db, schema: JSON.parse(db.schema) as PropertyDef[] };
}

export async function getDatabase(env: Env, actor: Actor, databaseId: string): Promise<DatabaseInfo> {
  const { db, schema } = await loadDb(env, actor, databaseId, "read");
  const views = await env.DB.prepare("SELECT id, name, type, config, revision FROM database_views WHERE database_id = ? ORDER BY position, id")
    .bind(databaseId)
    .all<{ id: string; name: string; type: "table" | "board"; config: string; revision: number }>();
  return {
    id: db.page_id,
    workspaceId: db.workspace_id,
    title: db.title,
    schema,
    revision: db.revision,
    views: views.results.map((v) => ({ ...v, config: JSON.parse(v.config) as ViewConfig })),
    url: pageUrl(env, db.page_id),
  };
}

/** Create a database (its own page + schema + default table/board views). Idempotent on `id`. */
export async function createDatabase(env: Env, actor: Actor, workspaceId: string, raw: unknown): Promise<DatabaseInfo> {
  const input = CreateDatabaseInput.parse(raw);
  const pageSummary = await createPage(env, actor, workspaceId, { parentId: input.parentId, title: input.title, id: input.id }, undefined, { isDatabase: true });
  if (!pageSummary.isDatabase) throw conflict("Id already used by a page");
  const schema = input.schema ?? DEFAULT_SCHEMA();
  const statusProp = schema.find((p) => p.type === "status" || p.type === "select");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO databases (page_id, workspace_id, schema) VALUES (?, ?, ?) ON CONFLICT(page_id) DO NOTHING").bind(
      pageSummary.id,
      workspaceId,
      JSON.stringify(schema),
    ),
    env.DB.prepare(
      "INSERT INTO database_views (id, database_id, workspace_id, name, type, config, position) SELECT ?, ?, ?, 'Table', 'table', ?, 0 WHERE NOT EXISTS (SELECT 1 FROM database_views WHERE database_id = ?)",
    ).bind(newId("vw"), pageSummary.id, workspaceId, JSON.stringify(EMPTY_VIEW), pageSummary.id),
    env.DB.prepare(
      "INSERT INTO database_views (id, database_id, workspace_id, name, type, config, position) SELECT ?, ?, ?, 'Board', 'board', ?, 1 WHERE (SELECT COUNT(*) FROM database_views WHERE database_id = ?) = 1 AND ? IS NOT NULL",
    ).bind(newId("vw"), pageSummary.id, workspaceId, JSON.stringify({ ...EMPTY_VIEW, groupBy: statusProp?.id ?? null }), pageSummary.id, statusProp?.id ?? null),
  ]);
  return getDatabase(env, actor, pageSummary.id);
}

function validateSchemaChange(before: PropertyDef[], after: PropertyDef[]): void {
  const titleBefore = before.find((p) => p.type === "title")!;
  const titleAfter = after.find((p) => p.type === "title")!;
  if (titleBefore.id !== titleAfter.id) throw new AppError("invalid_input", "The title property cannot be replaced");
  for (const p of after) {
    if ((p.type === "select" || p.type === "status") && !p.options?.length && p.type === "status") {
      throw new AppError("invalid_input", `Status property "${p.name}" needs at least one option`);
    }
    if (p.options && new Set(p.options.map((o) => o.id)).size !== p.options.length) throw new AppError("invalid_input", "Duplicate option id");
  }
}

export async function updateSchema(env: Env, actor: Actor, databaseId: string, raw: unknown): Promise<DatabaseInfo> {
  const { access, schema } = await loadDb(env, actor, databaseId, "write");
  const input = UpdateSchemaInput.parse(raw);
  validateSchemaChange(schema, input.schema);
  const res = await env.DB.prepare("UPDATE databases SET schema = ?, revision = revision + 1 WHERE page_id = ? AND revision = ?")
    .bind(JSON.stringify(input.schema), databaseId, input.expectedRevision)
    .run();
  if (!res.meta.changes) throw conflict("Schema was changed by someone else", await getDatabase(env, actor, databaseId));
  await audit(env, access, "database.schema", databaseId);
  await publish(env, access.workspaceId, [["database", databaseId]]);
  return getDatabase(env, actor, databaseId);
}

export async function createView(env: Env, actor: Actor, databaseId: string, raw: unknown): Promise<ViewInfo> {
  const { access, schema } = await loadDb(env, actor, databaseId, "write");
  const input = CreateViewInput.parse(raw);
  checkViewConfig(schema, input.config, input.type);
  const id = newId("vw");
  await env.DB.prepare(
    "INSERT INTO database_views (id, database_id, workspace_id, name, type, config, position) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM database_views WHERE database_id = ?))",
  )
    .bind(id, databaseId, access.workspaceId, input.name, input.type, JSON.stringify(input.config), databaseId)
    .run();
  await publish(env, access.workspaceId, [["database", databaseId]]);
  return { id, name: input.name, type: input.type, config: input.config, revision: 1 };
}

export async function updateView(env: Env, actor: Actor, databaseId: string, viewId: string, raw: unknown): Promise<ViewInfo> {
  const { access, schema } = await loadDb(env, actor, databaseId, "write");
  const input = UpdateViewInput.parse(raw);
  const view = await env.DB.prepare("SELECT id, name, type, config, revision FROM database_views WHERE id = ? AND database_id = ?")
    .bind(viewId, databaseId)
    .first<{ id: string; name: string; type: "table" | "board"; config: string; revision: number }>();
  if (!view) throw notFound("View");
  const next = { name: input.name ?? view.name, type: input.type ?? view.type, config: input.config ?? (JSON.parse(view.config) as ViewConfig) };
  checkViewConfig(schema, next.config, next.type);
  const res = await env.DB.prepare("UPDATE database_views SET name = ?, type = ?, config = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
    .bind(next.name, next.type, JSON.stringify(next.config), viewId, input.expectedRevision)
    .run();
  if (!res.meta.changes) throw conflict("View was changed by someone else");
  await publish(env, access.workspaceId, [["database", databaseId]]);
  return { id: viewId, ...next, revision: view.revision + 1 };
}

export async function deleteView(env: Env, actor: Actor, databaseId: string, viewId: string): Promise<void> {
  const { access } = await loadDb(env, actor, databaseId, "write");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM database_views WHERE database_id = ?").bind(databaseId).first<{ n: number }>();
  if ((count?.n ?? 0) <= 1) throw new AppError("conflict", "A database needs at least one view");
  await env.DB.prepare("DELETE FROM database_views WHERE id = ? AND database_id = ?").bind(viewId, databaseId).run();
  await publish(env, access.workspaceId, [["database", databaseId]]);
}

function checkViewConfig(schema: PropertyDef[], config: ViewConfig, type: "table" | "board") {
  for (const f of config.filters) compileFilter(schema, f, []);
  for (const s of config.sorts) if (s.propId !== "created_at") propOf(schema, s.propId);
  if (type === "board") {
    const g = config.groupBy ? propOf(schema, config.groupBy) : null;
    if (!g || (g.type !== "select" && g.type !== "status")) throw new AppError("invalid_input", "Board views group by a select or status property");
  }
}

function propOf(schema: PropertyDef[], id: string): PropertyDef {
  const def = schema.find((p) => p.id === id);
  if (!def) throw new AppError("invalid_input", `Unknown property ${id}`);
  return def;
}

// ---------- values ----------

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Validate a value for writing. Throws invalid_input with the property name. */
export function normalizeValue(def: PropertyDef, value: unknown): PropertyValue {
  if (value === null || value === undefined || value === "") return def.type === "checkbox" ? false : null;
  const bad = () => new AppError("invalid_input", `Invalid value for "${def.name}" (${def.type})`, { propId: def.id });
  switch (def.type) {
    case "title":
    case "text":
      if (typeof value !== "string") throw bad();
      return value.slice(0, def.type === "title" ? 500 : 10_000);
    case "url":
      if (typeof value !== "string" || !/^(https?:\/\/|mailto:)/i.test(value) || value.length > 2000) throw bad();
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
      return value;
    case "date":
      if (typeof value !== "string" || !DATE.test(value)) throw bad();
      return value;
    case "select":
    case "status":
      if (typeof value !== "string" || !def.options?.some((o) => o.id === value)) throw bad();
      return value;
    case "checkbox":
      if (typeof value !== "boolean") throw bad();
      return value;
  }
}

/** Read side: values that no longer fit the schema (type change, removed option) read as empty. */
function readValue(def: PropertyDef, value: unknown): PropertyValue {
  try {
    return normalizeValue(def, value);
  } catch {
    return def.type === "checkbox" ? false : null;
  }
}

interface RecordDbRow {
  id: string;
  title: string;
  props: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

function toRecord(env: Env, schema: PropertyDef[], row: RecordDbRow): RecordRow {
  const props = JSON.parse(row.props) as Record<string, unknown>;
  const values: Record<string, PropertyValue> = {};
  for (const def of schema) values[def.id] = def.type === "title" ? row.title : readValue(def, props[def.id]);
  return { id: row.id, title: row.title, values, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, url: pageUrl(env, row.id) };
}

function splitValues(schema: PropertyDef[], values: Record<string, unknown>): { title?: string; props: Record<string, PropertyValue> } {
  const props: Record<string, PropertyValue> = {};
  let title: string | undefined;
  for (const [key, value] of Object.entries(values)) {
    const def = propOf(schema, key);
    const v = normalizeValue(def, value);
    if (def.type === "title") title = (v as string | null) ?? "";
    else props[key] = v;
  }
  return { title, props };
}

export async function createRecord(env: Env, actor: Actor, databaseId: string, raw: unknown): Promise<RecordRow> {
  const { access, schema } = await loadDb(env, actor, databaseId, "write");
  const input = CreateRecordInput.parse(raw);
  const { title, props } = splitValues(schema, input.values);
  const summary = await createPage(env, actor, access.workspaceId, { parentId: databaseId, title: title ?? "", id: input.id }, undefined, {
    databaseId,
    props,
  });
  if (summary.databaseId !== databaseId) throw conflict("Id already used elsewhere");
  await publish(env, access.workspaceId, [["database", databaseId]]);
  return getRecord(env, actor, summary.id);
}

export async function getRecord(env: Env, actor: Actor, recordId: string): Promise<RecordRow> {
  const access = await requirePageAccess(env, actor, recordId, "read");
  if (!access.page.database_id) throw notFound("Record");
  const { schema } = await loadDb(env, actor, access.page.database_id, "read");
  const row = await env.DB.prepare("SELECT id, title, props, revision, created_at, updated_at FROM pages WHERE id = ?").bind(recordId).first<RecordDbRow>();
  return toRecord(env, schema, row!);
}

/** Update some property values. Revision-checked so concurrent edits never silently overwrite each other. */
export async function updateRecord(env: Env, actor: Actor, recordId: string, raw: unknown): Promise<RecordRow> {
  const access = await requirePageAccess(env, actor, recordId, "write");
  if (!access.page.database_id) throw notFound("Record");
  if (access.page.state !== "active") throw conflict("Record is in the trash");
  const { schema } = await loadDb(env, actor, access.page.database_id, "write");
  const input = UpdateRecordInput.parse(raw);
  const { title, props } = splitValues(schema, input.values);
  const res = await env.DB.prepare(
    `UPDATE pages SET title = COALESCE(?, title), props = json_patch(props, ?), revision = revision + 1, updated_at = ?, updated_by = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(title ?? null, JSON.stringify(props), Date.now(), actor.userId, recordId, input.expectedRevision)
    .run();
  const current = await getRecord(env, actor, recordId);
  if (!res.meta.changes) throw conflict("Record was changed by someone else", current);
  if (title !== undefined) await env.DB.prepare("UPDATE search_docs SET title = ? WHERE page_id = ?").bind(title, recordId).run();
  await publish(env, access.workspaceId, [["database", access.page.database_id], ["page", recordId]]);
  return current;
}

// ---------- query compiler ----------

function valueExpr(def: PropertyDef): string {
  // def.id matches /^p_[0-9A-Za-z]+$/ (validated by zod), so it is safe inside the JSON path.
  return def.type === "title" ? "p.title" : `json_extract(p.props, '$.${def.id}')`;
}

function compileFilter(schema: PropertyDef[], f: Filter, params: unknown[]): string {
  const def = propOf(schema, f.propId);
  const ops = FILTER_OPS[def.type] as readonly string[];
  if (!ops.includes(f.op)) throw new AppError("invalid_input", `Filter "${f.op}" is not available for ${def.type} properties`);
  const x = valueExpr(def);
  const need = (kind: "string" | "number" | "boolean") => {
    if (typeof f.value !== kind) throw new AppError("invalid_input", `Filter on "${def.name}" needs a ${kind} value`);
    params.push(kind === "boolean" ? (f.value ? 1 : 0) : f.value);
  };
  switch (f.op) {
    case "is_empty":
      return def.type === "number" || def.type === "select" || def.type === "status" ? `(${x} IS NULL)` : `(${x} IS NULL OR ${x} = '')`;
    case "is_not_empty":
      return def.type === "number" || def.type === "select" || def.type === "status" ? `(${x} IS NOT NULL)` : `(${x} IS NOT NULL AND ${x} != '')`;
    case "contains":
      need("string");
      return `instr(lower(COALESCE(${x}, '')), lower(?)) > 0`;
    case "not_contains":
      need("string");
      return `instr(lower(COALESCE(${x}, '')), lower(?)) = 0`;
    case "equals":
      need("string");
      return `COALESCE(${x}, '') = ?`;
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      need("number");
      return `${x} ${{ eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[f.op]} ?`;
    case "on":
    case "before":
    case "after":
      need("string");
      if (!DATE.test(String(f.value))) throw new AppError("invalid_input", "Date filters take YYYY-MM-DD");
      return `substr(${x}, 1, 10) ${{ on: "=", before: "<", after: ">" }[f.op]} substr(?, 1, 10)`;
    case "is":
      if (def.type === "checkbox") {
        need("boolean");
        return `COALESCE(${x}, 0) = ?`;
      }
      need("string");
      return `${x} = ?`;
    case "is_not":
      need("string");
      return `(${x} IS NULL OR ${x} != ?)`;
  }
  throw new AppError("invalid_input", `Unknown filter ${f.op}`);
}

interface SortKey {
  sql: string;
  params: unknown[];
  desc: boolean;
}

function sortKeys(schema: PropertyDef[], sorts: Sort[]): SortKey[] {
  const keys: SortKey[] = [];
  for (const s of sorts) {
    const desc = s.direction === "desc";
    if (s.propId === "created_at") {
      keys.push({ sql: "p.created_at", params: [], desc });
      continue;
    }
    const def = propOf(schema, s.propId);
    const x = valueExpr(def);
    if (def.type === "select" || def.type === "status") {
      const opts = def.options ?? [];
      const sql = opts.length ? `CASE ${x} ${opts.map(() => "WHEN ? THEN ?").join(" ")} ELSE ${opts.length} END` : "0";
      keys.push({ sql, params: opts.flatMap((o, i) => [o.id, i]), desc });
      continue;
    }
    // Empty values sort last in both directions.
    const empty = def.type === "number" || def.type === "checkbox" ? `(${x} IS NULL)` : `(${x} IS NULL OR ${x} = '')`;
    keys.push({ sql: `CASE WHEN ${empty} THEN 1 ELSE 0 END`, params: [], desc: false });
    const value = def.type === "number" ? `COALESCE(${x}, 0)` : def.type === "checkbox" ? `COALESCE(${x}, 0)` : `COALESCE(lower(${x}), '')`;
    keys.push({ sql: value, params: [], desc });
  }
  keys.push({ sql: "p.created_at", params: [], desc: false }, { sql: "p.id", params: [], desc: false });
  return keys;
}

function decodeCursor(cursor: string | null, n: number): unknown[] | null {
  if (!cursor) return null;
  try {
    const values = JSON.parse(atob(cursor)) as unknown;
    if (Array.isArray(values) && values.length === n && values.every((v) => typeof v === "string" || typeof v === "number")) return values;
  } catch {
    /* fall through */
  }
  throw new AppError("invalid_input", "Invalid cursor (sorts changed?)");
}

/** Filter/sort/paginate records server-side with keyset pagination (stable under concurrent inserts). */
export async function queryRecords(
  env: Env,
  actor: Actor,
  databaseId: string,
  raw: unknown,
): Promise<{ records: RecordRow[]; nextCursor: string | null; schemaRevision: number }> {
  const { db, schema } = await loadDb(env, actor, databaseId, "read");
  const input = QueryRecordsInput.parse(raw);
  const keys = sortKeys(schema, input.sorts);
  const params: unknown[] = [];
  const select = keys.map((k, i) => {
    params.push(...k.params);
    return `${k.sql} AS k${i}`;
  });
  params.push(databaseId);
  const where = input.filters.map((f) => compileFilter(schema, f, params));
  let sql = `SELECT * FROM (SELECT p.id, p.title, p.props, p.revision, p.created_at, p.updated_at, ${select.join(", ")}
    FROM pages p WHERE p.database_id = ? AND p.state = 'active'${where.map((w) => ` AND ${w}`).join("")})`;
  const after = decodeCursor(input.cursor, keys.length);
  if (after) {
    const ors = keys.map((k, i) => {
      const eq = keys.slice(0, i).map((_, j) => `k${j} = ?`);
      params.push(...after.slice(0, i), after[i]);
      return `(${[...eq, `k${i} ${k.desc ? "<" : ">"} ?`].join(" AND ")})`;
    });
    sql += ` WHERE ${ors.join(" OR ")}`;
  }
  sql += ` ORDER BY ${keys.map((k, i) => `k${i} ${k.desc ? "DESC" : "ASC"}`).join(", ")} LIMIT ?`;
  params.push(input.limit + 1);
  const rows = await env.DB.prepare(sql)
    .bind(...params)
    .all<RecordDbRow & Record<string, string | number>>();
  const page = rows.results.slice(0, input.limit);
  const last = page.at(-1);
  const nextCursor = rows.results.length > input.limit && last ? btoa(JSON.stringify(keys.map((_, i) => last[`k${i}`]))) : null;
  return { records: page.map((r) => toRecord(env, schema, r)), nextCursor, schemaRevision: db.revision };
}

// ---------- CSV ----------

export async function exportCsv(env: Env, actor: Actor, databaseId: string): Promise<string> {
  const { schema } = await loadDb(env, actor, databaseId, "read");
  const ordered = [...schema].sort((a, b) => (a.type === "title" ? -1 : b.type === "title" ? 1 : 0));
  const rows: (string | number | boolean | null)[][] = [ordered.map((p) => p.name)];
  let cursor: string | null = null;
  do {
    const res: Awaited<ReturnType<typeof queryRecords>> = await queryRecords(env, actor, databaseId, { cursor, limit: 200 });
    for (const r of res.records) {
      rows.push(
        ordered.map((p) => {
          const v = r.values[p.id] ?? null;
          return p.type === "select" || p.type === "status" ? (p.options?.find((o) => o.id === v)?.name ?? "") : v;
        }),
      );
    }
    cursor = res.nextCursor;
  } while (cursor && rows.length <= 10_001);
  return toCsv(rows);
}

/** Create a database from CSV. First column becomes the title; column types are inferred. */
export async function importCsv(
  env: Env,
  actor: Actor,
  workspaceId: string,
  csv: string,
  opts: { title: string; parentId: string | null },
): Promise<{ database: DatabaseInfo; imported: number; rejected: { row: number; reason: string }[]; warnings: string[] }> {
  await requireAccess(env, actor, workspaceId, "write");
  if (csv.length > 5_000_000) throw new AppError("too_large", "CSV is larger than 5 MB");
  let rows: string[][];
  try {
    rows = parseCsv(csv);
  } catch (err) {
    throw new AppError("invalid_input", (err as Error).message);
  }
  const header = rows.shift();
  if (!header?.length) throw new AppError("invalid_input", "CSV needs a header row");
  if (header.length > 50) throw new AppError("invalid_input", "CSV has more than 50 columns");
  const warnings: string[] = [];
  const rejected: { row: number; reason: string }[] = [];
  const good = rows.filter((r, i) => {
    if (r.length !== header.length) {
      rejected.push({ row: i + 2, reason: `expected ${header.length} columns, found ${r.length}` });
      return false;
    }
    return true;
  });
  const schema: PropertyDef[] = header.map((name, col) => {
    const clean = name.trim().slice(0, 100) || `Column ${col + 1}`;
    const id = col === 0 ? "p_title" : `p_c${col}${Math.random().toString(36).slice(2, 6)}`;
    if (col === 0) return { id, name: clean, type: "title" };
    const values = good.map((r) => r[col]!.trim()).filter(Boolean);
    if (values.length && values.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return { id, name: clean, type: "number" };
    if (values.length && values.every((v) => /^(true|false|yes|no)$/i.test(v))) return { id, name: clean, type: "checkbox" };
    if (values.length && values.every((v) => DATE.test(v))) return { id, name: clean, type: "date" };
    if (values.length && values.every((v) => /^https?:\/\/\S+$/i.test(v))) return { id, name: clean, type: "url" };
    const distinct = [...new Set(values)];
    if (values.length >= 4 && distinct.length <= Math.min(20, values.length / 2)) {
      return { id, name: clean, type: "select", options: distinct.map((d, i) => ({ id: `o_${i}${Math.random().toString(36).slice(2, 6)}`, name: d.slice(0, 100), color: "gray" as const })) };
    }
    return { id, name: clean, type: "text" };
  });
  const database = await createDatabase(env, actor, workspaceId, { title: opts.title, parentId: opts.parentId, schema });
  const t = Date.now();
  const statements: D1PreparedStatement[] = [];
  let imported = 0;
  let position = 0;
  good.forEach((r, i) => {
    const props: Record<string, PropertyValue> = {};
    try {
      schema.forEach((def, col) => {
        if (col === 0) return;
        const v = r[col]!.trim();
        if (!v) return;
        const parsed: unknown =
          def.type === "number" ? Number(v) : def.type === "checkbox" ? /^(true|yes)$/i.test(v) : def.type === "select" ? def.options!.find((o) => o.name === v.slice(0, 100))?.id : v;
        props[def.id] = normalizeValue(def, parsed);
      });
    } catch (err) {
      rejected.push({ row: i + 2, reason: (err as Error).message });
      return;
    }
    const title = r[0]!.slice(0, 500);
    const id = newId("pg");
    statements.push(
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, parent_id, database_id, title, position, props, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, workspaceId, database.id, database.id, title, `a${String(position++).padStart(6, "0")}`, JSON.stringify(props), actor.userId, t + i, actor.userId, t + i),
      env.DB.prepare("INSERT INTO search_docs (page_id, workspace_id, title) VALUES (?, ?, ?)").bind(id, workspaceId, title),
    );
    imported++;
  });
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  if (rejected.length) warnings.push(`${rejected.length} row(s) were rejected; see the list below.`);
  await publish(env, workspaceId, [["database", database.id]]);
  return { database, imported, rejected: rejected.slice(0, 500), warnings };
}
