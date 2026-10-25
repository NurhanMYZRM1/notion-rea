# Operations

Environments live in `apps/server/wrangler.jsonc`: top level = local development, `env.staging`, and
`env.production`. Each has its own Worker name, D1 database, R2 bucket and KV namespace. Never point
staging at production bindings. All commands run from `apps/server` with
`CLOUDFLARE_ACCOUNT_ID=636b468ba739e81c9a875f1c56f5d7bb`.

## Secrets (per environment, never in the repo or client bundles)

```bash
npx wrangler secret put BETTER_AUTH_SECRET --env production     # 32+ random bytes
npx wrangler secret put CONSENT_SECRET --env production
npx wrangler secret put ADMIN_TOKEN --env production          # enables /api/admin/backup|restore
npx wrangler secret put GOOGLE_CLIENT_ID --env production
npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
# optional, enables Sign in with Apple
npx wrangler secret put APPLE_CLIENT_ID --env production
npx wrangler secret put APPLE_CLIENT_SECRET --env production
npx wrangler secret put APPLE_APP_BUNDLE_IDENTIFIER --env production
```

Google Cloud Console → OAuth client (Web application): authorized redirect URI
`https://<HOST>/api/auth/callback/google`, JavaScript origin `https://<HOST>`. The native apps use the
same web client through the system browser (Better Auth Expo flow), so no separate iOS/Android client
is required for sign-in.

## Deploy

```bash
pnpm install --frozen-lockfile && pnpm check
pnpm --filter web build                                            # builds SPA + Worker bundle
npx wrangler d1 migrations apply DB --remote --env staging         # additive migrations first
npx wrangler deploy --env staging -c ../web/dist/workspace/wrangler.json
# smoke: /api/providers, sign-in, open a page, MCP login — then production with --env production
node scripts/bootstrap.mjs --remote --env production --email owner@example.com --url https://<HOST>
```

## Migrations and rollback

- Migrations are additive (new tables/columns/indexes). Apply before deploying code that uses them.
- Roll back code with `npx wrangler rollback --env production` (previous version). Additive schema
  stays; old code ignores it.
- Destructive data repair: D1 Time Travel (`npx wrangler d1 time-travel info DB --env production`,
  `… restore DB --timestamp <ISO>`). It restores metadata only; document bodies live in Durable
  Objects (see backups).

## Backups and restore

What is backed up, and how:

| Data | Backup | Restore |
|------|--------|---------|
| D1 metadata (users, workspaces, pages, records, comments, grants…) | D1 Time Travel (point in time, 30 days) + a nightly data export by the operator | `wrangler d1 time-travel restore`, or apply migrations to an empty DB and import the data export |
| Page bodies (Durable Objects) | Daily cron (`scheduled.ts` → `backup.ts`) copies the Yjs state of every page edited since its last backup to R2 `backups/docs/<ws>/<page>.yjs`; `doc_backups` records revision and key | `POST /api/admin/restore` (Bearer `ADMIN_TOKEN`) merges each backed-up state into its page object; idempotent |
| Search index | Not backed up: derived. Restored bodies re-project automatically | — |
| Attachments (R2 `ws/…`) | R2 durability; not copied | — |

Nightly D1 data export (excludes the FTS virtual table, which D1 export cannot include; rows are re-indexed by triggers on import):

```bash
npx wrangler d1 export DB --remote --env production --no-schema --output d1-$(date +%F).sql \
  $(for t in user session account verification workspaces members invitations pages databases database_views favorites recents comments attachments agent_grants audit_events doc_sessions doc_backups search_docs; do printf -- "--table %s " $t; done)
npx wrangler r2 object put workspace-files/backups/d1/d1-$(date +%F).sql --file d1-$(date +%F).sql --remote --env production
```

`search_docs.body` values can exceed D1's 100 KB statement limit on import; blank them in the export (or import
with bodies omitted) and let restored pages re-project.

**Restore drill** (required before trusting backups; run after schema changes):

```bash
node scripts/restore-drill.mjs --source .wrangler/perf-state --email perf@example.test
```

It backs up bodies in a source environment, exports D1 data, builds an empty isolated environment (migrations +
data import + backup objects), restores bodies, then checks every table row-for-row, every backed-up body and a
100-page sample through the API, and that search works. Last run (2026-10-26, local): `ok: true`, 19 tables /
20,060 rows identical, 2 bodies restored identical, 100 sampled pages identical, search returned results.

## Diagnosing

Logs are structured JSON (`wrangler tail --env production --format json`). They never contain page
bodies, cookies, tokens or authorization codes.

| Symptom | Check | Fix |
|---------|-------|-----|
| Everyone sees "Couldn't sync" / socket closes 4401 | Session expired or `BETTER_AUTH_SECRET` rotated | Sign in again; rotate secrets only with a planned sign-out |
| One user's socket closes 4403 | They were removed or demoted (`audit_events` action `member.*`) | Expected; their unsynced edits stay on the device as a draft |
| Edits stay "Saved on device" | Device offline, or WebSocket blocked by a proxy | Check `/sync/<id>` upgrade in devtools; status returns to "Synced" after reconnect |
| `projection_failed` log lines | D1 unavailable or slow | Automatic retry with backoff (max 5 min). Search may lag; page reads are unaffected |
| Search misses a recent edit | Projection lag (normally ~2 s) | Check `search_docs.revision` vs the page revision (`GET /api/pages/:id/document`) |
| MCP calls return "connection was revoked" | `agent_grants.revoked_at` set | Reconnect from the client (`claude mcp login` / `codex mcp login`) |
| MCP 403 `insufficient_scope` | Token lacks write/archive | Client re-authorizes; tick the scope on the consent page |
| Upload 413/415 | Size > 25 MB or type not allowed | Expected limits in `domain/attachments.ts` |

## Rate limits

`API_LIMIT` (Workers Rate Limiting) caps 600 API requests per user per minute; Better Auth limits
sign-in attempts in production.
