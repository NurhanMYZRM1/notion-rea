# Blueprint: Workspace (Notion-inspired collaborative workspace on Cloudflare)

Mode: direct (repo initialised locally with git; no GitHub remote yet). Progress lives in
[docs/LEDGER.md](../docs/LEDGER.md). Research lives in [docs/research/feature-matrix.md](../docs/research/feature-matrix.md).

## Invariants (checked after every step)

- `pnpm check` passes (typecheck + lint + unit/worker tests).
- One write path per datum: D1 owns metadata, the page Durable Object owns document bodies.
- Every API/MCP/WebSocket entry point goes through `apps/server/src/domain/*` authorization.
- No secrets in client bundles; no page bodies, tokens, or codes in logs.
- No UI for deferred features.

## Architecture (decided)

```
apps/server   Hono Worker: /api (REST), /api/auth (Better Auth), /sync/:pageId (page DO),
              /events/:workspaceId (workspace DO), /mcp (MCP via agents createMcpHandler),
              /oauth/* + /.well-known (workers-oauth-provider), static SPA assets.
apps/web      React + Vite SPA, lazy editor chunk, IndexedDB doc cache, service worker shell.
apps/mobile   Expo Router native app; editor = one Expo DOM component (WebView) fed by a typed bridge;
              Y.Doc + WebSocket + SQLite live on the native side.
packages/core contracts (zod), roles/permissions, block schema helpers, Yjs<->block conversion,
              markdown/CSV, API client, sync provider (platform-neutral, pluggable persistence).
packages/editor Tiptap extensions + React editor component shared by web and the mobile DOM component.
```

Storage: D1 (metadata, FTS5 search projection), R2 (attachments, backups), DO SQLite (Yjs update log +
chunked snapshots + projection outbox), KV `OAUTH_KV` (required by workers-oauth-provider for
grants/tokens; D1 `agent_grants` remains the revocation authority).

Sync protocol (WebSocket, binary): y-protocols sync (0) + awareness (1) + custom `ack` (2, server →
client after the update is committed to DO storage, carries revision) + `control` (3, JSON: read-only,
revoked, deleted, error). Client states: saving-locally → saved-on-device → synchronizing →
synchronized | offline | failed.

## Steps

Each step: context, tasks, verify, exit criteria. Parallel-safe steps are marked ∥.

### S1 Scaffold + Worker vertical slice (serial, strongest model)
Context: empty repo. Tasks: pnpm workspace, TS config, wrangler config with D1/R2/DO/KV bindings,
D1 migration 0001, Hono app, page DO with Yjs persistence/ack, workspace DO, test-only login gated by
`ENVIRONMENT != production`. Verify: `pnpm --filter server test` (vitest-pool-workers) covers DO
restart recovery, duplicate updates, ack-after-commit. Exit: two WS clients converge in workerd test.

### S2 Auth + invitations + roles (serial after S1)
Better Auth (Google, Apple when configured, Expo plugin), bootstrap command, invitations (hash-stored
token, 7-day expiry, single use, bound to verified email), roles. Verify: authz matrix tests, expired/
reused/wrong-email invitation tests. Exit: signing in alone grants nothing.

### S3 Web shell + shared editor (∥ with S4 after S2)
Sidebar tree, breadcrumbs, favorites, recents, trash/restore, editor blocks, slash menu, drag/keyboard
reorder, comments, attachments, status indicator, IndexedDB + service worker. Verify: Playwright two-
browser convergence, offline edit → reload → reconnect convergence, keyboard a11y, axe. Exit: journeys
pass on `wrangler dev`.

### S4 MCP + OAuth (∥ with S3 after S2)
OAuthProvider wrapping app, consent page, grants table, Agent Connections API, MCP tools with per-tool
scopes, block edits applied in page DO. Verify: worker tests for denial/refresh/revocation/wrong
audience/missing scope; real `claude mcp login` and `codex mcp login`; MCP edit visible in live editor.

### S5 Databases + search + portability (after S3)
Schema/views/records API with revision checks, keyset pagination, filter/sort compiler, table/board UI,
FTS5 projection via DO alarm outbox, Markdown/CSV import/export with report. Verify: 10k-row pagination
test, stale projection rejection, tombstones, import fixtures.

### S6 Native app (after S3 core editor; ∥ with S5)
Expo Router screens, Better Auth Expo client, DOM-component editor bridge, SQLite update store, cache
limits (20 docs / 50 MB, never evict dirty), drafts on revoke/delete, logout wipe with export. Verify:
iOS simulator Maestro flows (when Maestro available), bridge unit tests, force-quit recovery test.

### S7 Hardening + delivery (after all)
Security review, perf fixtures (200-block, 1,000-block, 10k rows), backup/restore drill, staging +
production deploy, EAS build profiles, store metadata, docs. Verify: deployed smoke, restore drill,
recorded perf numbers.

## Rollback

Each step lands as its own commit. D1 migrations are additive; rollback = redeploy previous Worker
version (`wrangler rollback`) and leave additive tables in place.

## Plan mutation

Record any split/skip/reorder in the ledger "Plan changes" section with the reason.
