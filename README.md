# Workspace

An invite-only collaborative workspace (documents, databases, real-time editing) for web, iOS and
Android, hosted on Cloudflare, with its own MCP server for Claude Code and Codex. Product name is
provisional.

- Architecture and API: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Progress and decisions: [docs/LEDGER.md](docs/LEDGER.md)
- MCP client setup: [docs/MCP.md](docs/MCP.md)
- Operations (deploy, secrets, rollback, backups, troubleshooting): [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Performance plan and results: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
- Research (what was observed vs. chosen): [docs/research/feature-matrix.md](docs/research/feature-matrix.md)
- Mobile build and store testing: [apps/mobile/README.md](apps/mobile/README.md)

## Quick start (local)

```bash
pnpm install
cp apps/server/.dev.vars.example apps/server/.dev.vars
pnpm --filter server exec wrangler d1 migrations apply DB --local --persist-to ../../.wrangler/state
pnpm --filter web dev                                   # http://localhost:5173
pnpm --filter server bootstrap -- --email you@example.com --name "Team"   # prints the owner invite link
```

Local development has a test-only email sign-in (disabled in production) so you can sign in without
Google. Sign in with the bootstrap email, then open the printed invite link.

## Checks

```bash
pnpm check          # typecheck + lint + unit/Workers tests
pnpm --filter web e2e
node scripts/seed-perf.mjs --url http://localhost:5173 --email you@example.com
node scripts/restore-drill.mjs
```
