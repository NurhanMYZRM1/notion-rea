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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    source: { type: "string", default: ".wrangler/perf-state" },
    target: { type: "string", default: ".wrangler/restore-drill" },
    email: { type: "string", default: "perf@example.test" },
    password: { type: "string", default: "perf-fixture-password" },
  },
});
const root = new URL("..", import.meta.url).pathname;
const server = `${root}apps/server`;
const abs = (p) => (p.startsWith("/") ? p : `${root}${p}`);
const SRC = abs(o.source);
const DST = abs(o.target);
const work = `${DST}-work`;
const ADMIN = `drill-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const BUCKET = "workspace-dev-files";

const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { cwd: server, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

async function start(port, state) {
  const child = spawn("npx", ["wrangler", "dev", "--port", String(port), "--var", `PUBLIC_URL:http://localhost:${port}`, "--var", `ADMIN_TOKEN:${ADMIN}`, "--persist-to", state], { cwd: server, stdio: "ignore" });
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

// 2. export SOURCE D1, 3. build TARGET
wrangler(["d1", "export", "DB", "--local", "--persist-to", SRC, "--output", `${work}/d1.sql`]);
const keys = JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--persist-to", SRC, "--json", "--command", "SELECT r2_key FROM doc_backups"]))[0].results.map((r) => r.r2_key);
wrangler(["d1", "execute", "DB", "--local", "--persist-to", DST, "--file", `${work}/d1.sql`, "--yes"]);
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
  report.missingObjects = missing;
  const [sc, dc] = [await session("http://localhost:8792"), await session("http://localhost:8793")];
  const ids = JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--persist-to", SRC, "--json", "--command", "SELECT id FROM pages WHERE state != 'deleted'"]))[0].results.map((r) => r.id);
  const mismatches = [];
  for (const id of ids) {
    const get = async (base, cookie) => (await (await fetch(`${base}/api/pages/${id}/document`, { headers: { Cookie: cookie } })).json()).doc;
    const [a, b] = [await get("http://localhost:8792", sc), await get("http://localhost:8793", dc)];
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(id);
  }
  report.pagesCompared = ids.length;
  report.mismatches = mismatches;
} finally {
  src.kill();
  dst.kill();
}
report.ok = report.mismatches.length === 0 && report.missingObjects.length === 0 && report.pagesCompared > 0;
report.finishedAt = new Date().toISOString();
writeFileSync(`${work}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
