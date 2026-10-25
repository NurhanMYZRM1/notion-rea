# Architecture

Product name is provisional: "Workspace" (`APP_NAME` in each client's config).

## Layout

| Path | What |
|------|------|
| `packages/core` | Contracts (zod), roles/permissions, block model + Yjs⇄ProseMirror JSON (`blocks.ts`), Markdown/CSV, `createApiClient`, sync protocol + `SyncProvider` (`core/sync`) |
| `packages/editor` | Tiptap schema (`schema.ts`, also used by the server), `WorkspaceEditor` React component, slash menu, block actions, styles (`styles.css`) |
| `apps/server` | Hono Worker + Durable Objects (`PageDocument`, `WorkspaceChannel`), Better Auth, MCP (`/mcp`), OAuth (`/authorize`, `/oauth/*`), D1 migrations |
| `apps/web` | React + Vite SPA, served by the same Worker (Cloudflare Vite plugin) |
| `apps/mobile` | Expo Router app; native screens + one editor DOM component |

## Data ownership

- **D1**: users/sessions (Better Auth), workspaces, members, invitations, page tree + titles + lifecycle,
  record property values, database schemas/views, comments, attachments metadata, agent grants, audit,
  `doc_sessions`, search projection (`search_docs` + FTS5 `search_fts`).
- **PageDocument DO (one per page, `idFromName(pageId)`)**: canonical Yjs body. SQLite tables `updates`
  (append-only log), `snapshot` (≤1 MB chunks), `meta` (revision, projection outbox). Compacts after 500
  updates / 4 MB. Search projection via alarm, retried with backoff; D1 rejects stale revisions.
- **WorkspaceChannel DO (one per workspace)**: metadata invalidation fan-out only (no content).
- **R2 `FILES`**: private attachments at `ws/<workspaceId>/<attachmentId>`; served only via `/api/attachments/:id`.
- **KV `OAUTH_KV`**: required by `@cloudflare/workers-oauth-provider` (hashed tokens, encrypted props).
  D1 `agent_grants` stays authoritative for revocation.

## Authorization

`apps/server/src/domain/access.ts` → `requireAccess` / `requirePageAccess` is the only check, used by REST,
MCP and WebSocket entry points. Membership is re-read per request. Non-members get 404. Agents need
both the scope (`workspace:read|write|archive`) and a role that allows the action; the D1 grant must be
unrevoked. Page DOs re-check membership/page state on writes every 5 s and are told to close sockets
when a member is removed (`doc_sessions` → `revokeUser`).

## REST API (all JSON; session cookie on web, `Cookie` header on native)

```
GET  /api/providers                         {google, apple, testLogin}
GET  /api/me                                {user, workspaces[]}
DELETE /api/me                              delete account (refused if sole owner)
POST /api/invitations/accept {token}
GET  /api/agent-grants   DELETE /api/agent-grants/:id
PATCH /api/w/:ws {name}
GET  /api/w/:ws/pages?parentId=&cursor=     sidebar children (bounded, cursor)
POST /api/w/:ws/pages {parentId?, title?, id?, afterId?}
GET  /api/w/:ws/favorites | recents | trash | search?q= | members | invitations
PATCH/DELETE /api/w/:ws/members/:userId     POST /api/w/:ws/invitations {email, role} → {invitation, url}
DELETE /api/w/:ws/invitations/:id
POST /api/w/:ws/databases | import/markdown {markdown,parentId,title?} | import/csv {csv,parentId,title}
GET/PATCH /api/pages/:id {expectedRevision,title?,icon?}   POST /api/pages/:id/move {expectedRevision,parentId,afterId?}
POST /api/pages/:id/archive | restore       DELETE /api/pages/:id (permanent, owners, trash only)
PUT /api/pages/:id/favorite {favorite}      POST /api/pages/:id/visit
GET /api/pages/:id/document → {doc, revision}   POST /api/pages/:id/edit {ops, expectedRevision?} (MCP edit ops)   GET /api/pages/:id/export.md[?format=json]
GET/POST /api/pages/:id/comments            DELETE /api/pages/:id/comments/:cid
POST /api/pages/:id/attachments (raw body; Content-Type, Content-Length, X-File-Name) → {src,...}
GET  /api/attachments/:id
GET  /api/databases/:id   PUT .../schema {expectedRevision, schema}
POST .../views  PATCH/DELETE .../views/:vid   POST .../query {filters,sorts,cursor,limit}
POST .../records {values,id?}   GET .../export.csv
GET/PATCH /api/records/:id {expectedRevision, values}
```

Errors: `{error:{code,message,details?}}`; codes in `core/contracts.ts` (`conflict` = 409 carries
`details.current`). Every create accepts a client id for idempotent retries.

## Realtime

- `GET /sync/:pageId` (WebSocket). Protocol in `packages/core/src/sync/protocol.ts`: y-protocols sync +
  awareness, plus `ACK(revision)` sent only after the update is committed to DO storage, and JSON
  `CONTROL` (`hello`, `read-only`, `state`, `revoked`, `deleted`). Close codes 4401/4403/4404/4410.
- `SyncProvider` (platform-neutral) drives status: `saving-local → saved-device → syncing → synced`,
  plus `offline` and `failed`. Pass a `DocStore` (IndexedDB on web, SQLite on native). It never claims
  server durability before an ACK.
- `GET /events/:workspaceId` (WebSocket): `{type:"invalidate", invalidate:[["pages", parentId], ["page", id],
  ["database", id], ["comments", pageId], ["members"], ["trash"], ["recents"], ["workspaces"]]}`.
  Clients refetch matching queries, and refetch everything after reconnecting.

## MCP

`/mcp` Streamable HTTP via `agents/mcp/server` `createMcpHandler` + `@modelcontextprotocol/server` 2.3.1,
wrapped by `OAuthProvider`. Tools in `apps/server/src/mcp/server.ts`, each with `scopeChallenge`
(per-tool scope step-up) and the same domain functions as REST. Document edits go through
`PageDocument.edit` → same commit/broadcast path as editor updates.

## Local development

```bash
pnpm install
cp apps/server/.dev.vars.example apps/server/.dev.vars
pnpm --filter server exec wrangler d1 migrations apply DB --local --persist-to ../../.wrangler/state
pnpm --filter web dev                     # http://localhost:5173 (SPA + Worker in workerd)
pnpm --filter server bootstrap -- --email you@example.com --name "Team"
```

Local and CI only: `TEST_LOGIN=enabled` turns on email/password sign-in so tests can sign in without
Google. It is disabled in code when `ENVIRONMENT=production`.
