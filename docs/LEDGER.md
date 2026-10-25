# Task ledger

Resume here. Plan: [plans/workspace-blueprint.md](../plans/workspace-blueprint.md). Architecture:
[ARCHITECTURE.md](ARCHITECTURE.md). Research: [research/feature-matrix.md](research/feature-matrix.md).

## Decisions and inputs

- Cloudflare account: `Syedakmalhadif@gmail.com's Account` (`f51018eeed73777b08a81d5ca30ab318`), chosen by the user.
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
| S2 auth, invitations, roles | code done, tests pending | |
| S3 web app | in progress | |
| S4 MCP + OAuth | code done, tests + real clients pending | |
| S5 databases/search/portability | API done, UI pending | |
| S6 native app | pending | |
| S7 hardening/deploy | pending | |

## Plan changes

- Idempotency table dropped: retryable creates use client ids; MCP derives ids from `idempotencyKey`
  (sha256 of workspace+user+key), so retries hit `ON CONFLICT DO NOTHING`.
- Page comments only (no inline text comments) this release, per brief.
- Board "move card" sets the group property (our choice; Notion docs don't specify).

## Open blockers / external inputs

- **Cloudflare permissions (deploy blocker):** on account f51018ee… the login is only "Individual Workers Editor"; `wrangler d1 list` / `r2 bucket list` / `kv namespace list` fail with `Authentication error [code: 10000]` (checked 2026-10-26). User chose to keep this account and get a role covering Workers, D1, KV and R2 from its super admin. Next action after they confirm: create `workspace-staging` and `workspace` D1/R2/KV, fill ids in `wrangler.jsonc` envs, migrate, deploy.

- Google OAuth client ID/secret (web + iOS + Android client IDs) — needed for real sign-in.
- Apple Sign in config (Services ID, key) — iOS release dependency.
- Play Console + App Store Connect access, app identifiers, signing — store testing channels.
- Physical Android (3–4 GB) and iPhone SE 2-class device — performance gate.
