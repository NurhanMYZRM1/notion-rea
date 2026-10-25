#!/usr/bin/env node
// Restore drill: proves a backup can be restored, not just taken.
// 1. backs up page bodies in a SOURCE local environment (POST /api/admin/backup → R2 + doc_backups)
// 2. exports SOURCE D1 (`wrangler d1 export`)
// 3. builds an empty, isolated TARGET environment: imports the D1 export, copies the backup objects
// 4. restores page bodies into TARGET Durable Objects (POST /api/admin/restore)
// 5. compares every page's canonical content between SOURCE and TARGET and prints a report
//
//   node scripts/restore-drill.mjs --source .wrangler/perf-state --email perf@example.test
// Exit code 0 only if every page matches.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    source: { type: "string", default: ".wrangler/perf-state" },
    target: { type: "string", default: ".wrangler/restore-drill" },
    email: { type: "string", default: "perf@example.test" },
    password: { type: "string", default: "perf-fixture-password" },
  },
});
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}apps/server`;
const abs = (p) => (p.startsWith("/") ? p : `${root}${p}`);
const SRC = abs(o.source);
const DST = abs(o.target);
const work = `${DST}-work`;
const ADMIN = `drill-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const BUCKET = "workspace-dev-files";

const WRANGLER = `${server}/node_modules/.bin/wrangler`;
const wrangler = (args, opts = {}) => execFileSync(WRANGLER, args, { cwd: server, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });

async function start(port, state) {
  const child = spawn(WRANGLER, ["dev", "--port", String(port), "--var", `PUBLIC_URL:http://localhost:${port}`, "--var", `ADMIN_TOKEN:${ADMIN}`, "--persist-to", state], { cwd: server, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      if ((await fetch(`http://localhost:${port}/api/providers`)).ok) return child;
    } catch {}
  }
  child.kill();
  throw new Error(`worker on ${port} did not start`);
}

async function session(base) {
  const res = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ email: o.email, password: o.password }) });
  if (!res.ok) throw new Error(`sign-in failed on ${base}: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function admin(base, path) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", Origin: base }, body: "{}" });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

rmSync(DST, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const report = { source: SRC, target: DST, startedAt: new Date().toISOString() };

// 1. backup in SOURCE
let src = await start(8792, SRC);
try {
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const r = await admin("http://localhost:8792", "/api/admin/backup");
    total += r.backedUp;
    if (!r.more) break;
  }
  report.backedUp = total;
} finally {
  src.kill();
  await sleep(1000);
}

// 2. export SOURCE D1 data (not the derived FTS index: D1 export can't include virtual tables),
// 3. build TARGET: migrations create schema + FTS + triggers; inserting search_docs repopulates search.
const d1Dir = `${SRC}/v3/d1/miniflare-D1DatabaseObject`;
const d1File = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite")).map((f) => `${d1Dir}/${f}`)[0];
const db = new DatabaseSync(d1File, { readOnly: true });
const skip = /^(sqlite_|_cf_|d1_migrations$|search_fts)/;
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'").all().map((r) => r.name).filter((n) => !skip.test(n));
const lit = (v) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString("hex")}'` : `'${String(v).replace(/'/g, "''")}'`);
const order = ["user", "workspaces"]; // parents first for foreign keys
tables.sort((a, b) => (order.indexOf(b) + 1 || 0) - (order.indexOf(a) + 1 || 0));
let sql = "PRAGMA defer_foreign_keys = true;\n";
let rowsExported = 0;
for (const t of tables) {
  // search_docs is derived; bodies can exceed D1's 100 KB statement limit and are re-projected after restore.
  const select = t === "search_docs" ? `SELECT rowid, page_id, workspace_id, title, '' AS body, 0 AS revision FROM "${t}"` : `SELECT * FROM "${t}"`;
  for (const row of db.prepare(select).all()) {
    sql += `INSERT INTO "${t}" (${Object.keys(row).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(row).map(lit).join(", ")});\n`;
    rowsExported++;
  }
}
db.close();
writeFileSync(`${work}/d1-data.sql`, sql);
report.d1 = { tables: tables.length, rows: rowsExported };
const keys = new DatabaseSync(d1File, { readOnly: true }).prepare("SELECT r2_key FROM doc_backups").all().map((r) => r.r2_key);
wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", DST]);
wrangler(["d1", "execute", "DB", "--local", "--persist-to", DST, "--file", `${work}/d1-data.sql`, "--yes"]);
// Metadata check right after import, before restore/sign-ins touch anything.
// Metadata: every exported table must match row-for-row (search_docs: titles only; bodies are re-projected).
const dstDir = `${DST}/v3/d1/miniflare-D1DatabaseObject`;
const dstFile = readdirSync(dstDir).filter((f) => f.endsWith(".sqlite")).map((f) => `${dstDir}/${f}`)[0];
const [srcDb, dstDb] = [new DatabaseSync(d1File, { readOnly: true }), new DatabaseSync(dstFile, { readOnly: true })];
const digest = (conn, t) => {
  const cols = t === "search_docs" ? "page_id, workspace_id, title" : "*";
  const rows = conn.prepare(`SELECT ${cols} FROM "${t}" ORDER BY 1`).all();
  return { n: rows.length, h: createHash("sha256").update(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))).digest("hex") };
};
report.tableMismatches = tables.filter((t) => JSON.stringify(digest(srcDb, t)) !== JSON.stringify(digest(dstDb, t)));
srcDb.close();
dstDb.close();
keys.forEach((key, i) => {
  const file = `${work}/obj-${i}.yjs`;
  wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--local", "--persist-to", SRC, "--file", file]);
  wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--local", "--persist-to", DST, "--file", file]);
});
report.objectsCopied = keys.length;

// 4. restore bodies in TARGET, 5. compare
src = await start(8792, SRC);
const dst = await start(8793, DST);
try {
  let restored = 0;
  const missing = [];
  for (let i = 0; i < 100; i++) {
    const r = await admin("http://localhost:8793", "/api/admin/restore");
    restored += r.restored;
    missing.push(...r.missing);
    if (!r.next) break;
  }
  report.restored = restored;
  await sleep(4000); // restored bodies re-project into search via each page's alarm (~2 s)
  report.missingObjects = missing;
  const [sc, dc] = [await session("http://localhost:8792"), await session("http://localhost:8793")];
  // Bodies: every backed-up page plus a random sample of the rest, through the API.
  const a = new DatabaseSync(d1File, { readOnly: true });
  const withBody = a.prepare("SELECT page_id FROM doc_backups").all().map((r) => r.page_id);
  const sample = a.prepare("SELECT id FROM pages WHERE state != 'deleted' ORDER BY random() LIMIT 100").all().map((r) => r.id);
  a.close();
  const get = async (base, cookie, id) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${base}/api/pages/${id}/document`, { headers: { Cookie: cookie } });
      if (res.status === 429) {
        await sleep(15_000);
        continue;
      }
      if (!res.ok) throw new Error(`${base} ${id}: HTTP ${res.status}`);
      return (await res.json()).doc;
    }
    throw new Error(`${base} ${id}: still rate limited`);
  };
  const mismatches = [];
  const errors = [];
  const ids = [...new Set([...withBody, ...sample])];
  for (const id of ids) {
    try {
      if (JSON.stringify(await get("http://localhost:8792", sc, id)) !== JSON.stringify(await get("http://localhost:8793", dc, id))) mismatches.push(id);
    } catch (err) {
      errors.push(String(err.message));
    }
  }
  report.bodiesCompared = { withBody: withBody.length, sampled: ids.length - withBody.length };
  report.mismatches = mismatches;
  report.readErrors = errors;
  const hits = await (await fetch(`http://localhost:8793/api/w/${(await (await fetch("http://localhost:8793/api/me", { headers: { Cookie: dc } })).json()).workspaces[0].id}/search?q=quarterly`, { headers: { Cookie: dc } })).json();
  report.searchAfterRestore = hits.results?.length ?? 0;
} finally {
  src.kill();
  dst.kill();
}
report.ok = report.mismatches.length === 0 && report.readErrors.length === 0 && report.tableMismatches.length === 0 && report.missingObjects.length === 0 && report.bodiesCompared.withBody > 0 && report.searchAfterRestore > 0;
report.finishedAt = new Date().toISOString();
writeFileSync(`${work}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
