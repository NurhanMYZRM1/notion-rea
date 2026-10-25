#!/usr/bin/env node
// Provision and deploy one environment (staging | production) on the configured Cloudflare account:
//   1. find-or-create D1 `workspace-<env>`, R2 `workspace-<env>-files`, KV `workspace-<env>-oauth`
//   2. write their ids, the worker name and PUBLIC_URL (workers.dev) into apps/server/wrangler.jsonc env.<env>
//   3. apply D1 migrations
//   4. build SPA + Worker for that env and deploy, uploading generated secrets that don't exist yet
//      (BETTER_AUTH_SECRET, CONSENT_SECRET, ADMIN_TOKEN) in the same version — never printed
//
//   CLOUDFLARE_ACCOUNT_ID=636b468ba739e81c9a875f1c56f5d7bb node scripts/provision.mjs --env staging
// Re-running is safe: existing resources and secrets are reused.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: { env: { type: "string" }, "skip-deploy": { type: "boolean", default: false } } });
if (o.env !== "staging" && o.env !== "production") throw new Error("--env staging|production");
const env = o.env;
const root = fileURLToPath(new URL("..", import.meta.url));
const server = `${root}apps/server`;
const configPath = `${server}/wrangler.jsonc`;
const WRANGLER = `${server}/node_modules/.bin/wrangler`;
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? JSON.parse(readFileSync(configPath, "utf8")).account_id;
const run = (args, opts = {}) =>
  execFileSync(WRANGLER, args, { cwd: opts.cwd ?? server, encoding: "utf8", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account }, stdio: ["pipe", "pipe", "inherit"], maxBuffer: 32 << 20, ...opts });

const names = { worker: env === "production" ? "workspace" : "workspace-staging", d1: `workspace-${env}`, r2: `workspace-${env}-files`, kv: `workspace-${env}-oauth` };

// 1. resources
const d1 = JSON.parse(run(["d1", "list", "--json"])).find((d) => d.name === names.d1) ?? (run(["d1", "create", names.d1]), JSON.parse(run(["d1", "list", "--json"])).find((d) => d.name === names.d1));
const kvList = () => JSON.parse(run(["kv", "namespace", "list"]));
const kv = kvList().find((n) => n.title === names.kv) ?? (run(["kv", "namespace", "create", names.kv]), kvList().find((n) => n.title === names.kv));
let buckets;
try {
  buckets = run(["r2", "bucket", "list"], { stdio: ["pipe", "pipe", "pipe"] });
} catch (err) {
  throw new Error(`R2 is not available on this account (${String(err.stderr ?? err).match(/Please enable R2[^\n]*/)?.[0] ?? "see wrangler output"}). Enable it in the dashboard (R2 > Overview) and re-run.`);
}
if (!new RegExp(`\\b${names.r2}\\b`).test(buckets)) run(["r2", "bucket", "create", names.r2]);
if (!d1?.uuid || !kv?.id) throw new Error("could not find/create D1 or KV");

// workers.dev subdomain → PUBLIC_URL (custom domains: set PUBLIC_URL by hand afterwards)
const token = readFileSync(`${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`, "utf8").match(/^oauth_token = "([^"]+)"/m)?.[1];
const sub = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN ?? token}` } }).then((r) => r.json());
if (!sub.success) throw new Error(`cannot read workers.dev subdomain: ${JSON.stringify(sub.errors)}`);
const publicUrl = `https://${names.worker}.${sub.result.subdomain}.workers.dev`;

// 2. config
const config = JSON.parse(readFileSync(configPath, "utf8"));
const top = config;
config.env ??= {};
config.env[env] = {
  name: names.worker,
  vars: { ENVIRONMENT: env, PUBLIC_URL: publicUrl, OAUTH_CIMD: "disabled" },
  d1_databases: [{ binding: "DB", database_name: names.d1, database_id: d1.uuid, migrations_dir: "migrations" }],
  r2_buckets: [{ binding: "FILES", bucket_name: names.r2 }],
  kv_namespaces: [{ binding: "OAUTH_KV", id: kv.id }],
  durable_objects: top.durable_objects,
  ratelimits: [{ ...top.ratelimits[0], namespace_id: env === "production" ? "1003" : "1002" }],
};
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`[${env}] D1 ${d1.uuid}, KV ${kv.id}, R2 ${names.r2}, URL ${publicUrl}`);
if (o["skip-deploy"]) process.exit(0);

// 3. migrations (before code that uses them)
run(["d1", "migrations", "apply", "DB", "--remote", "--env", env], { stdio: ["pipe", "inherit", "inherit"] });

// 4. build + deploy with any missing generated secrets in the same version (no window without secrets)
let existing = [];
try {
  existing = JSON.parse(run(["secret", "list", "--env", env, "--format", "json"], { stdio: ["pipe", "pipe", "ignore"] })).map((x) => x.name);
} catch {
  /* first deploy: the Worker doesn't exist yet */
}
const fresh = Object.fromEntries(["BETTER_AUTH_SECRET", "CONSENT_SECRET", "ADMIN_TOKEN"].filter((n) => !existing.includes(n)).map((n) => [n, randomBytes(32).toString("base64url")]));
const secretsFile = `${mkdtempSync(`${tmpdir()}/ws-secrets-`)}/secrets.json`;
writeFileSync(secretsFile, JSON.stringify(fresh), { mode: 0o600 });
try {
  execFileSync("pnpm", ["--filter", "web", "build"], { cwd: root, stdio: "inherit", env: { ...process.env, CLOUDFLARE_ENV: env, CLOUDFLARE_ACCOUNT_ID: account } });
  run(["deploy", ...(Object.keys(fresh).length ? ["--secrets-file", secretsFile] : [])], { cwd: `${root}apps/web`, stdio: ["pipe", "inherit", "inherit"] });
} finally {
  rmSync(secretsFile, { force: true });
}
console.log(`[${env}] deployed: ${publicUrl} (new secrets: ${Object.keys(fresh).join(", ") || "none"})\nNext: wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET --env ${env}, then bootstrap the owner.`);
