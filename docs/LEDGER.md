# Task ledger

Resume here. Plan: [plans/workspace-blueprint.md](../plans/workspace-blueprint.md). Architecture:
[ARCHITECTURE.md](ARCHITECTURE.md). Research: [research/feature-matrix.md](research/feature-matrix.md).

## Decisions and inputs

- Cloudflare account: **`Paragonxplays@gmail.com's Account` (`636b468ba739e81c9a875f1c56f5d7bb`)**, switched 2026-10-26 at the user's request (the Syedakmalhadif account only granted a single-Worker policy). Hostnames: `workspace-staging.paragonxplays.workers.dev`, `workspace.paragonxplays.workers.dev`. D1 staging `040195a7-d4b3-44c0-9b45-2f15da92128d`, production `6e6f2055-a3db-4116-be97-77699d3827b8`; KV `workspace-<env>-oauth`.
- Initial owner: `paragonxplays@gmail.com` (bootstrap command, not auto-membership).
- Google OAuth client: not created yet (user will add secrets via `wrangler secret put`).
- Toolchain verified 2026-10-25: Node 26.10, pnpm 12.15, Xcode 27.1 + iPhone 17 Pro simulator (iOS 26.5),
  EAS CLI logged in, Claude Code 2.1.306, Codex CLI 0.157.1. **No Java/Android SDK/adb, no Maestro** locally.
- Library choices actually installed: see lockfile. Notables: MCP SDK v2 (`@modelcontextprotocol/server`
  2.3.1, required by `agents` 0.30.1 `createMcpHandler`), `@cloudflare/workers-oauth-provider` 1.2.4
  (needs KV `OAUTH_KV`), Better Auth 1.7.13 native D1 dialect, Tiptap 3.32, Yjs 13.6.33,
  `@cloudflare/vitest-plugin` 1.4.7 (successor of vitest-pool-workers), TypeScript 6.0.3 (TS 7 skipped
  for tooling compatibility).

## Status

| Step | State | Evidence |
|------|-------|----------|
| A Discovery, matrix, blueprint | done | docs/research, plans/ |
| S1 core + Worker + DOs | done | `apps/server` sync tests 7/7, core 13/13, editor encoding 2/2 |
| S2 auth, invitations, roles | done | server suite 221/221 (authz matrix, isolation, invitations, members, pages, attachments, databases incl. 10k rows, search, MCP/OAuth, backup, compaction, archive) |
| S3 web app | done | typecheck/build/lint clean; Playwright 14/14 (auth, collab+carets, offline reload, database, editor, ack-before-synced, search, tree keyboard, viewer, revoked draft, settings, trash, axe); initial shell 105.8 KiB gzip |
| S4 MCP + OAuth | done locally; deployed check pending | `test/mcp.test.ts` 8/8; real Codex + Claude Code OAuth login and read/write tool calls verified 2026-10-26 (docs/MCP.md). CIMD opt-in; pre-dispatch per-tool scope step-up |
| S5 databases/search/portability | done | server tests + web database spec; CSV/Markdown import/export |
| S6 native app | done on iOS simulator | tsc clean, 12 node tests; Debug + Release on iPhone 17 Pro sim: sign-in, invites, editing, offline force-quit/relaunch, resync. Not verified: Android, devices, Maestro, uploads, non-ASCII paste |
| S7 hardening/deploy | deployed | staging `https://workspace-staging.paragonxplays.workers.dev` (version 676e2fc9), production `https://workspace.paragonxplays.workers.dev` (version bf29178c); smoke checks pass; restore drill ok |

## Plan changes

- Idempotency table dropped: retryable creates use client ids; MCP derives ids from `idempotencyKey`
  (sha256 of workspace+user+key), so retries hit `ON CONFLICT DO NOTHING`.
- Page comments only (no inline text comments) this release, per brief.
- Board "move card" sets the group property (our choice; Notion docs don't specify).

## Open blockers / external inputs


- Google OAuth client ID/secret (web + iOS + Android client IDs) — needed for real sign-in.
- Apple Sign in config (Services ID, key) — iOS release dependency.
- Play Console + App Store Connect access, app identifiers, signing — store testing channels.
- Physical Android (3–4 GB) and iPhone SE 2-class device — performance gate.

## Resume checklist (stopped 2026-10-26 at usage limit)

1. `git log -1` is a WIP snapshot. Run `pnpm --filter server test`, `pnpm -r typecheck`, `pnpm --filter web build` and fix what the stopped agents left half-done (apps/web, apps/mobile, apps/server/test).
2. Wire `src/backup.ts` into `scheduled.ts` + admin routes `POST /api/admin/backup|restore` (Bearer `ADMIN_TOKEN`), then run `node scripts/restore-drill.mjs`.
3. Claude Code MCP check: in `/tmp/claude-mcp-test` approve the project server in `claude` (arrow down to "Yes, I trust this folder"), then `claude mcp login workspace-local`; local test backend: `wrangler dev --port 8794 --var PUBLIC_URL:http://localhost:8794 --persist-to ../../.wrangler/mcp-state`. Remove `workspace-local` from `~/.codex/config.toml` afterwards (`codex mcp remove workspace-local`).
4. Deployment after the Cloudflare role is granted: add `env.staging`/`env.production` to wrangler.jsonc, create D1/R2/KV, migrate, set secrets, deploy (docs/OPERATIONS.md).

## After deployment (2026-10-26)

- Both environments deployed by `scripts/provision.mjs`; generated `BETTER_AUTH_SECRET`, `CONSENT_SECRET`,
  `ADMIN_TOKEN` live only in Cloudflare secrets.
- Smoke-checked on both: SPA + security headers, `testLogin:false` (email sign-up 400), OAuth discovery on the
  deployed origin, signed-out `/mcp` 401 with resource metadata, signed-out sockets close 4401, admin 404.
- **Next (needs the user):** create a Google OAuth web client with redirect
  `https://<host>/api/auth/callback/google` for each host, `wrangler secret put GOOGLE_CLIENT_ID/SECRET --env …`,
  then `node apps/server/scripts/bootstrap.mjs --remote --env production --email paragonxplays@gmail.com --url https://workspace.paragonxplays.workers.dev`
  and repeat the MCP client logins against the deployed `/mcp`.
- Mobile store builds: `eas build` not run; App Store Connect / Play Console ids are placeholders in `apps/mobile/eas.json`.
- An `apps/desktop` Tauri app and matching root script/README/.gitignore edits appeared on 2026-10-26 08:04 from
  outside this session; left uncommitted for their owner (its dependency is in the committed lockfile).
