import { parseCsv } from "@workspace/core";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { api, BASE, createWorkspace, newDatabase, signUp, type TestUser } from "./helpers";

let owner: TestUser;
let ws: string;
beforeAll(async () => {
  owner = await signUp();
  ws = await createWorkspace(owner);
});

const SCHEMA = [
  { id: "p_title", name: "Name", type: "title" },
  { id: "p_text", name: "Notes", type: "text" },
  { id: "p_numb", name: "Count", type: "number" },
  { id: "p_date", name: "Due", type: "date" },
  { id: "p_sele", name: "Colour", type: "select", options: [{ id: "o_red1", name: "Red" }, { id: "o_blue", name: "Blue" }] },
  { id: "p_stat", name: "Status", type: "status", options: [{ id: "o_todo", name: "Todo" }, { id: "o_doing", name: "Doing" }, { id: "o_done", name: "Done" }] },
  { id: "p_chkd", name: "Done?", type: "checkbox" },
  { id: "p_link", name: "Link", type: "url" },
];
const ROWS = {
  r1: { p_title: "Alpha", p_text: "hello world", p_numb: 10, p_date: "2026-01-15", p_sele: "o_red1", p_stat: "o_todo", p_chkd: true, p_link: "https://a.example" },
  r2: { p_title: "beta", p_text: "", p_numb: 5.5, p_date: "2026-02-01T10:00:00Z", p_sele: "o_blue", p_stat: "o_done", p_chkd: false, p_link: "mailto:x@y.example" },
  r3: { p_title: "Gamma" },
  r4: { p_title: "", p_text: "HELLO there", p_numb: -3, p_date: "2025-12-31", p_sele: "o_red1", p_stat: "o_doing", p_chkd: true, p_link: "https://b.example" },
};
type Key = keyof typeof ROWS;

async function typedDb() {
  const db = await newDatabase(owner, ws, { schema: SCHEMA });
  const ids = {} as Record<Key, string>;
  for (const [key, values] of Object.entries(ROWS) as [Key, Record<string, unknown>][]) {
    const res = await api(owner, "POST", `/api/databases/${db.id}/records`, { values });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ids[key] = res.body.record.id;
  }
  const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k])) as Record<string, Key>;
  const query = async (body: Record<string, unknown>) => {
    const res = await api(owner, "POST", `/api/databases/${db.id}/query`, body);
    return { status: res.status, keys: res.status === 200 ? (res.body.records as { id: string }[]).map((r) => names[r.id]) : res.body };
  };
  return { db, ids, query };
}

describe("database schema and revisions", () => {
  it("validates schemas", async () => {
    const bad = [
      [{ id: "p_title", name: "A", type: "title" }, { id: "p_titl2", name: "B", type: "title" }],
      [{ id: "p_text", name: "A", type: "text" }],
      [{ id: "p_title", name: "A", type: "title" }, { id: "p_title", name: "B", type: "text" }],
      [{ id: "p_title", name: "A", type: "title" }, { id: "bad'); DROP TABLE pages;--", name: "B", type: "text" }],
      [{ id: "p_title", name: "A", type: "title" }, { id: "p_x$.y", name: "B", type: "text" }],
      [{ id: "p_title", name: "A", type: "title" }, { id: "p_kind", name: "B", type: "formula" }],
    ];
    for (const schema of bad) expect((await api(owner, "POST", `/api/w/${ws}/databases`, { title: "x", schema })).status, JSON.stringify(schema)).toBe(400);

    const db = await newDatabase(owner, ws);
    const put = (schema: unknown, expectedRevision = db.revision) => api(owner, "PUT", `/api/databases/${db.id}/schema`, { expectedRevision, schema });
    expect((await put([{ id: "p_name2", name: "Name", type: "title" }])).status).toBe(400); // title replaced
    expect((await put([{ id: "p_title", name: "Name", type: "title" }, { id: "p_stat", name: "S", type: "status", options: [] }])).status).toBe(400);
    expect((await put([{ id: "p_title", name: "Name", type: "title" }, { id: "p_sele", name: "S", type: "select", options: [{ id: "o_aaaa", name: "a" }, { id: "o_aaaa", name: "b" }] }])).status).toBe(400);
    const ok = await put([...db.schema, { id: "p_notes", name: "Notes", type: "text" }]);
    expect(ok.status).toBe(200);
    expect(ok.body.database.revision).toBe(db.revision + 1);
    const stale = await put(db.schema);
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current.schema.map((p: { id: string }) => p.id)).toContain("p_notes");
  });

  it("returns the current state on view and record conflicts", async () => {
    const db = await newDatabase(owner, ws);
    const view = db.views[0];
    const first = await api(owner, "PATCH", `/api/databases/${db.id}/views/${view.id}`, { expectedRevision: view.revision, name: "First" });
    expect(first.body.view).toMatchObject({ name: "First", revision: view.revision + 1 });
    const stale = await api(owner, "PATCH", `/api/databases/${db.id}/views/${view.id}`, { expectedRevision: view.revision, name: "Second" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current).toMatchObject({ id: view.id, name: "First", revision: view.revision + 1 });

    const rec = (await api(owner, "POST", `/api/databases/${db.id}/records`, { values: { p_title: "R" } })).body.record;
    const upd = await api(owner, "PATCH", `/api/records/${rec.id}`, { expectedRevision: rec.revision, values: { p_status: "o_done" } });
    expect(upd.body.record.values.p_status).toBe("o_done");
    const staleRec = await api(owner, "PATCH", `/api/records/${rec.id}`, { expectedRevision: rec.revision, values: { p_status: "o_todo" } });
    expect(staleRec.status).toBe(409);
    expect(staleRec.body.error.details.current).toMatchObject({ id: rec.id, revision: upd.body.record.revision, values: { p_status: "o_done" } });
    // Invalid values name the property.
    const invalid = await api(owner, "PATCH", `/api/records/${rec.id}`, { expectedRevision: upd.body.record.revision, values: { p_status: "o_nope" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toEqual({ propId: "p_status" });
    expect((await api(owner, "PATCH", `/api/records/${rec.id}`, { expectedRevision: upd.body.record.revision, values: { p_unknown: "x" } })).status).toBe(400);
    // Board views must group by select/status; view filters are validated.
    expect((await api(owner, "POST", `/api/databases/${db.id}/views`, { name: "B", type: "board", config: { groupBy: "p_title" } })).status).toBe(400);
    expect((await api(owner, "POST", `/api/databases/${db.id}/views`, { name: "T", type: "table", config: { filters: [{ propId: "p_zzzz", op: "is_empty" }] } })).status).toBe(400);
    expect((await api(owner, "DELETE", `/api/databases/${db.id}/views/${db.views[1].id}`)).status).toBe(200);
    expect((await api(owner, "DELETE", `/api/databases/${db.id}/views/${db.views[0].id}`)).status).toBe(409);
  });
});

describe("database queries", () => {
  it("supports every filter op per type", async () => {
    const { query } = await typedDb();
    const cases: [unknown, Key[]][] = [
      [{ propId: "p_title", op: "contains", value: "A" }, ["r1", "r2", "r3"]],
      [{ propId: "p_title", op: "not_contains", value: "alp" }, ["r2", "r3", "r4"]],
      [{ propId: "p_title", op: "equals", value: "beta" }, ["r2"]],
      [{ propId: "p_title", op: "is_empty" }, ["r4"]],
      [{ propId: "p_title", op: "is_not_empty" }, ["r1", "r2", "r3"]],
      [{ propId: "p_text", op: "contains", value: "hello" }, ["r1", "r4"]],
      [{ propId: "p_text", op: "not_contains", value: "hello" }, ["r2", "r3"]],
      [{ propId: "p_text", op: "equals", value: "hello world" }, ["r1"]],
      [{ propId: "p_text", op: "is_empty" }, ["r2", "r3"]],
      [{ propId: "p_text", op: "is_not_empty" }, ["r1", "r4"]],
      [{ propId: "p_text", op: "contains", value: "%" }, []],
      [{ propId: "p_text", op: "contains", value: "' OR 1=1 --" }, []],
      [{ propId: "p_numb", op: "eq", value: 10 }, ["r1"]],
      [{ propId: "p_numb", op: "neq", value: 10 }, ["r2", "r4"]],
      [{ propId: "p_numb", op: "gt", value: 5 }, ["r1", "r2"]],
      [{ propId: "p_numb", op: "gte", value: 5.5 }, ["r1", "r2"]],
      [{ propId: "p_numb", op: "lt", value: 0 }, ["r4"]],
      [{ propId: "p_numb", op: "lte", value: 5.5 }, ["r2", "r4"]],
      [{ propId: "p_numb", op: "is_empty" }, ["r3"]],
      [{ propId: "p_numb", op: "is_not_empty" }, ["r1", "r2", "r4"]],
      [{ propId: "p_date", op: "on", value: "2026-02-01" }, ["r2"]],
      [{ propId: "p_date", op: "before", value: "2026-01-01" }, ["r4"]],
      [{ propId: "p_date", op: "after", value: "2026-01-15" }, ["r2"]],
      [{ propId: "p_date", op: "is_empty" }, ["r3"]],
      [{ propId: "p_date", op: "is_not_empty" }, ["r1", "r2", "r4"]],
      [{ propId: "p_sele", op: "is", value: "o_red1" }, ["r1", "r4"]],
      [{ propId: "p_sele", op: "is_not", value: "o_red1" }, ["r2", "r3"]],
      [{ propId: "p_sele", op: "is_empty" }, ["r3"]],
      [{ propId: "p_sele", op: "is_not_empty" }, ["r1", "r2", "r4"]],
      [{ propId: "p_stat", op: "is", value: "o_done" }, ["r2"]],
      [{ propId: "p_stat", op: "is_not", value: "o_done" }, ["r1", "r3", "r4"]],
      [{ propId: "p_chkd", op: "is", value: true }, ["r1", "r4"]],
      [{ propId: "p_chkd", op: "is", value: false }, ["r2", "r3"]],
      [{ propId: "p_link", op: "contains", value: "EXAMPLE" }, ["r1", "r2", "r4"]],
      [{ propId: "p_link", op: "equals", value: "mailto:x@y.example" }, ["r2"]],
      [{ propId: "p_link", op: "is_empty" }, ["r3"]],
    ];
    for (const [filter, want] of cases) {
      const res = await query({ filters: [filter] });
      expect(res.status, JSON.stringify(filter)).toBe(200);
      expect((res.keys as Key[]).sort(), JSON.stringify(filter)).toEqual(want);
    }
    const anded = await query({ filters: [{ propId: "p_sele", op: "is", value: "o_red1" }, { propId: "p_chkd", op: "is", value: true }, { propId: "p_numb", op: "gt", value: 0 }] });
    expect(anded.keys).toEqual(["r1"]);
    // Board grouping: one query per column plus "no value"; together they cover every record exactly once.
    const columns = await Promise.all([
      ...["o_todo", "o_doing", "o_done"].map((o) => query({ filters: [{ propId: "p_stat", op: "is", value: o }] })),
      query({ filters: [{ propId: "p_stat", op: "is_empty" }] }),
    ]);
    expect(columns.map((c) => c.keys)).toEqual([["r1"], ["r4"], ["r2"], ["r3"]]);

    for (const bad of [
      { propId: "p_numb", op: "contains", value: "1" },
      { propId: "p_numb", op: "eq", value: "5" },
      { propId: "p_date", op: "on", value: "tomorrow" },
      { propId: "p_chkd", op: "is_empty" },
      { propId: "p_nope", op: "is_empty" },
      { propId: "p_text", op: "contains" },
      { propId: "p_text", op: "regexp", value: "x" },
    ]) {
      expect((await query({ filters: [bad] })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await query({ sorts: [{ propId: "p_nope", direction: "asc" }] })).status).toBe(400);
    expect((await query({ cursor: "not-a-cursor" })).status).toBe(400);
  });

  it("sorts by option order, keeps empties last both ways, and combines sorts", async () => {
    const { query } = await typedDb();
    const sorted = async (...sorts: [string, "asc" | "desc"][]) => (await query({ sorts: sorts.map(([propId, direction]) => ({ propId, direction })) })).keys;
    expect(await sorted(["p_sele", "asc"])).toEqual(["r1", "r4", "r2", "r3"]);
    expect(await sorted(["p_sele", "desc"])).toEqual(["r2", "r1", "r4", "r3"]);
    expect(await sorted(["p_stat", "asc"])).toEqual(["r1", "r4", "r2", "r3"]);
    expect(await sorted(["p_stat", "desc"])).toEqual(["r2", "r4", "r1", "r3"]);
    expect(await sorted(["p_numb", "asc"])).toEqual(["r4", "r2", "r1", "r3"]);
    expect(await sorted(["p_numb", "desc"])).toEqual(["r1", "r2", "r4", "r3"]);
    expect(await sorted(["p_text", "asc"])).toEqual(["r4", "r1", "r2", "r3"]);
    expect(await sorted(["p_text", "desc"])).toEqual(["r1", "r4", "r2", "r3"]);
    expect(await sorted(["p_title", "asc"])).toEqual(["r1", "r2", "r3", "r4"]);
    expect(await sorted(["p_title", "desc"])).toEqual(["r3", "r2", "r1", "r4"]);
    expect(await sorted(["p_date", "asc"])).toEqual(["r4", "r1", "r2", "r3"]);
    expect(await sorted(["p_chkd", "desc"])).toEqual(["r1", "r4", "r2", "r3"]);
    expect(await sorted(["created_at", "desc"])).toEqual(["r4", "r3", "r2", "r1"]);
    expect(await sorted(["p_sele", "asc"], ["p_numb", "desc"])).toEqual(["r1", "r4", "r2", "r3"]);
    expect(await sorted(["p_sele", "asc"], ["p_numb", "asc"])).toEqual(["r4", "r1", "r2", "r3"]);
    expect(await sorted(["p_chkd", "asc"], ["p_title", "desc"])).toEqual(["r3", "r2", "r1", "r4"]);
  });

  it("paginates with cursors over Unicode and long sort values", async () => {
    const db = await newDatabase(owner, ws, { schema: [{ id: "p_title", name: "Name", type: "title" }, { id: "p_text", name: "Notes", type: "text" }] });
    const titles = ["Émile", "日本語のページ", "😀 emoji", "zebra", "Ångström", "naïve"];
    for (const [i, t] of titles.entries()) {
      await api(owner, "POST", `/api/databases/${db.id}/records`, { values: { p_title: t, p_text: `${"x".repeat(3000)}${i}` } });
    }
    for (const propId of ["p_title", "p_text"]) {
      for (const direction of ["asc", "desc"]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const res: { status: number; body: any } = await api(owner, "POST", `/api/databases/${db.id}/query`, { sorts: [{ propId, direction }], limit: 1, cursor });
          expect(res.status, `${propId} ${direction} ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
          seen.push(...res.body.records.map((r: { title: string }) => r.title));
          cursor = res.body.nextCursor;
        } while (cursor && seen.length < 20);
        expect(seen.sort(), `${propId} ${direction}`).toEqual([...titles].sort());
      }
    }
  });

  it("keyset-paginates 10,000 rows without duplicates or skips, even with inserts mid-way", async () => {
    const db = await newDatabase(owner, ws, { schema: [{ id: "p_title", name: "Name", type: "title" }, { id: "p_numb", name: "N", type: "number" }] });
    const t0 = Date.now() - 1_000_000;
    const insertRows = async (from: number, count: number, createdAt: (i: number) => number) => {
      const statements: D1PreparedStatement[] = [];
      for (let i = from; i < from + count; i++) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO pages (id, workspace_id, parent_id, database_id, title, position, props, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(`pg_bulk${String(i).padStart(10, "0")}`, ws, db.id, db.id, `row ${i}`, "a0", JSON.stringify(i % 11 === 0 ? {} : { p_numb: i % 7 }), createdAt(i), createdAt(i)),
        );
      }
      for (let i = 0; i < statements.length; i += 500) await env.DB.batch(statements.slice(i, i + 500));
    };
    // Many identical created_at values and sort keys: only the id tiebreak keeps the order total.
    await insertRows(0, 10_000, (i) => t0 + Math.floor(i / 3));

    for (const sorts of [[], [{ propId: "p_numb", direction: "desc" }], [{ propId: "p_title", direction: "asc" }, { propId: "p_numb", direction: "asc" }]]) {
      const seen = new Map<string, number>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { status: number; body: any } = await api(owner, "POST", `/api/databases/${db.id}/query`, { sorts, limit: 200, cursor });
        expect(res.status).toBe(200);
        for (const r of res.body.records as { id: string }[]) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
        cursor = res.body.nextCursor;
        // Concurrent inserts half-way: some sort before the cursor, some after.
        if (++pages === 25 && sorts.length === 0) await insertRows(20_000, 100, (i) => (i % 2 ? t0 - 1 : Date.now()));
      } while (cursor);
      const dupes = [...seen.values()].filter((n) => n > 1).length;
      expect(dupes, JSON.stringify(sorts)).toBe(0);
      for (let i = 0; i < 10_000; i += 1) if (!seen.has(`pg_bulk${String(i).padStart(10, "0")}`)) throw new Error(`skipped row ${i} with sorts ${JSON.stringify(sorts)}`);
    }
    // The ordering itself is right for the number sort (empties last).
    const first = await api(owner, "POST", `/api/databases/${db.id}/query`, { sorts: [{ propId: "p_numb", direction: "desc" }], limit: 3 });
    expect(first.body.records.map((r: { values: { p_numb: number } }) => r.values.p_numb)).toEqual([6, 6, 6]);
  }, 120_000);
});

describe("CSV and Markdown portability", () => {
  const csv = [
    "﻿Name,Notes,Count,Done,Due,Site,Team",
    '"Smith, J","said ""hi""\nthen left",3,yes,2026-01-02,https://a.example,Red',
    "Åsa 日本 😀,plain,4.5,no,2026-01-03,https://b.example,Blue",
    "Short row,only two",
    "Third,x,7,yes,2026-01-04,https://c.example,Red",
    "Fourth,y,-2,no,2026-01-05,https://d.example,Blue",
    "Fifth,z,0,yes,2026-01-06,https://e.example,Red",
    "Too,many,1,yes,2026-01-07,https://f.example,Red,extra",
  ].join("\r\n");

  it("imports quoted, multi-line and Unicode CSV, reports bad rows and infers types", async () => {
    const res = await api(owner, "POST", `/api/w/${ws}/import/csv`, { csv, title: "Imported" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.imported).toBe(5);
    expect(res.body.rejected).toEqual([
      { row: 4, reason: "expected 7 columns, found 2" },
      { row: 8, reason: "expected 7 columns, found 8" },
    ]);
    const types = Object.fromEntries((res.body.database.schema as { name: string; type: string }[]).map((p) => [p.name, p.type]));
    expect(types).toEqual({ Name: "title", Notes: "text", Count: "number", Done: "checkbox", Due: "date", Site: "url", Team: "select" });
    const dbId = res.body.database.id;
    const rows = (await api(owner, "POST", `/api/databases/${dbId}/query`, { limit: 50 })).body.records as { title: string; values: Record<string, unknown> }[];
    expect(rows.map((r) => r.title)).toEqual(["Smith, J", "Åsa 日本 😀", "Third", "Fourth", "Fifth"]);
    const notes = res.body.database.schema.find((p: { name: string }) => p.name === "Notes").id;
    expect(rows[0]!.values[notes]).toBe('said "hi"\nthen left');
    // Records can still be added after an import (positions must stay valid fractional keys).
    const added = await api(owner, "POST", `/api/databases/${dbId}/records`, { values: { p_title: "Added later" } });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await api(owner, "GET", `/api/w/${ws}/search?q=Fourth`)).body.results.map((r: { title: string }) => r.title)).toEqual(["Fourth"]);
  });

  it("reports rejected values with the original row number", async () => {
    // Row 2 has too many columns; row 4's URL is too long to store (rejected at value time, still numbered by CSV row).
    const longUrl = `https://example.com/${"a".repeat(2100)}`;
    const res = await api(owner, "POST", `/api/w/${ws}/import/csv`, { csv: `Name,Link\nbad,1,2\nok,https://a.example\nlong,${longUrl}\nfine,https://b.example\n`, title: "Rows" });
    expect(res.body.rejected).toEqual([
      { row: 2, reason: "expected 2 columns, found 3" },
      { row: 4, reason: 'Invalid value for "Link" (url)' },
    ]);
    expect(res.body.imported).toBe(2);
    // One imported row: its position must still be a valid fractional key for later inserts.
    const single = await api(owner, "POST", `/api/w/${ws}/import/csv`, { csv: "Name\nonly\n", title: "Single" });
    expect((await api(owner, "POST", `/api/databases/${single.body.database.id}/records`, { values: { p_title: "next" } })).status).toBe(201);
    for (const [body, status] of [
      [{ csv: "", title: "x" }, 400],
      [{ csv: 'a,"b\n', title: "x" }, 400],
      [{ csv: Array.from({ length: 51 }, (_, i) => `c${i}`).join(",") + "\n", title: "x" }, 400],
      [{ csv: "Name\nA\n" }, 400],
    ] as const) {
      expect((await api(owner, "POST", `/api/w/${ws}/import/csv`, body)).status, JSON.stringify(body).slice(0, 80)).toBe(status);
    }
  });

  it("exports CSV that round-trips and neutralises formulas", async () => {
    const imported = await api(owner, "POST", `/api/w/${ws}/import/csv`, { csv, title: "Round trip" });
    const dbId = imported.body.database.id;
    for (const title of ["=HYPERLINK(\"http://evil.example\")", "+SUM(1)", "-2+3+cmd|' /C calc'!A0", "@SUM(A1)", "\tTabbed"]) {
      await api(owner, "POST", `/api/databases/${dbId}/records`, { values: { p_title: title } });
    }
    const res = await SELF.fetch(`${BASE}/api/databases/${dbId}/export.csv`, { headers: { Cookie: owner.cookie } });
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
    const out = parseCsv(await res.text());
    expect(out[0]).toEqual(["Name", "Notes", "Count", "Done", "Due", "Site", "Team"]);
    expect(out.slice(1, 6)).toEqual([
      ["Smith, J", 'said "hi"\nthen left', "3", "true", "2026-01-02", "https://a.example", "Red"],
      ["Åsa 日本 😀", "plain", "4.5", "false", "2026-01-03", "https://b.example", "Blue"],
      ["Third", "x", "7", "true", "2026-01-04", "https://c.example", "Red"],
      ["Fourth", "y", "-2", "false", "2026-01-05", "https://d.example", "Blue"],
      ["Fifth", "z", "0", "true", "2026-01-06", "https://e.example", "Red"],
    ]);
    const exportedTitles = out.slice(6).map((r) => r[0]);
    for (const t of exportedTitles) expect(t, t).toMatch(/^'/);

    // Importing the export gives the same data back.
    const again = await api(owner, "POST", `/api/w/${ws}/import/csv`, { csv: toCsvLines(out.slice(0, 6)), title: "Again" });
    const back = parseCsv(await (await SELF.fetch(`${BASE}/api/databases/${again.body.database.id}/export.csv`, { headers: { Cookie: owner.cookie } })).text());
    expect(back).toEqual(out.slice(0, 6));
  });

  it("imports Markdown with Unicode and reports unsupported content", async () => {
    const md = "# Café ☕ notes\n\nGrüße 日本語 😀\n\n#### Deep heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>raw</div>\n\n![img](https://example.com/x.png)\n";
    const res = await api(owner, "POST", `/api/w/${ws}/import/markdown`, { markdown: md });
    expect(res.status).toBe(201);
    expect(res.body.page.title).toBe("Café ☕ notes");
    expect(res.body.warnings.length).toBeGreaterThanOrEqual(3);
    expect(res.body.warnings.join(" ")).toMatch(/Heading level 4/);
    expect(res.body.warnings.join(" ")).toMatch(/Table/);
    const exported = await api(owner, "GET", `/api/pages/${res.body.page.id}/export.md?format=json`);
    expect(exported.body.markdown).toContain("# Café ☕ notes");
    expect(exported.body.markdown).toContain("Grüße 日本語 😀");
  });
});

function toCsvLines(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}
