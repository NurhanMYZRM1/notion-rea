#!/usr/bin/env node
// Explicit initial-owner bootstrap: creates a workspace and a single-use, 7-day owner invitation bound
// to one email. The owner signs in with that (verified) Google account and opens the printed link.
//
//   pnpm --filter server bootstrap -- --email owner@example.com [--name "Workspace"]
//       [--remote --env production --url https://workspace.example.workers.dev] [--force]
//       [--state ../../.wrangler/other-state]   (local persistence dir; matches wrangler dev --persist-to)
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string", default: "Workspace" },
    remote: { type: "boolean", default: false },
    env: { type: "string" },
    url: { type: "string", default: "http://localhost:5173" },
    force: { type: "boolean", default: false },
    state: { type: "string", default: "../../.wrangler/state" },
  },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: bootstrap --email owner@example.com [--name Workspace] [--remote --env production --url https://…]");
  process.exit(1);
}
const sql = (s) => `'${String(s).replace(/'/g, "''")}'`;
const target = [values.remote ? "--remote" : "--local", ...(values.env ? ["--env", values.env] : []), ...(values.remote ? [] : ["--persist-to", values.state])];
const d1 = (command) =>
  JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", ...target, "--json", "--command", command], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));

const existing = d1("SELECT COUNT(*) AS n FROM workspaces")[0].results[0].n;
if (existing > 0 && !values.force) {
  console.error(`Refusing: ${existing} workspace(s) already exist. Invite people from the app, or pass --force to create another workspace.`);
  process.exit(2);
}
const id = (p) => `${p}_${randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, 22)}`;
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const now = Date.now();
const ws = id("ws");
d1(
  `INSERT INTO workspaces (id, name, created_by, created_at) VALUES (${sql(ws)}, ${sql(values.name)}, NULL, ${now});
   INSERT INTO invitations (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at)
     VALUES (${sql(id("inv"))}, ${sql(ws)}, ${sql(email)}, 'owner', ${sql(hash)}, NULL, ${now}, ${now + 7 * 864e5});`,
);
console.log(`Workspace ${ws} created.\nOwner invitation for ${email} (single use, expires in 7 days):\n\n  ${values.url.replace(/\/$/, "")}/invite#${token}\n`);
