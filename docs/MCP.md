# Connecting Claude Code and Codex

The MCP endpoint is `https://<HOST>/mcp` (Streamable HTTP, OAuth 2.1 with PKCE S256, dynamic client
registration and Client ID Metadata Documents). Signing in uses your normal Workspace account in the
browser; you then pick **one workspace** and the permissions to grant:

| Scope | Allows (and only if your role allows it too) |
|-------|----------------------------------------------|
| `workspace:read` | always granted: search, list/read pages and blocks, databases, records, comments |
| `workspace:write` | create/edit pages and blocks, databases, records, comments |
| `workspace:archive` | move pages to the trash and restore them |

Clients first ask for `workspace:read`. A write or archive tool called without its scope gets an HTTP
403 `insufficient_scope` challenge, and the client re-authorizes for the extra scope.

Revoke any time: **Settings → Agent connections → Revoke** (takes effect on the next call, even if the
token has not expired). Removing a member also revokes their agent connections.

## Claude Code (tested with 2.1.306)

```bash
claude mcp add --transport http --scope project notion-workspace https://HOST/mcp
claude mcp login notion-workspace        # or run /mcp inside Claude Code and choose Authenticate
```

`--scope project` writes `.mcp.json` in the current project. `claude mcp login --no-browser` prints the
authorization URL for headless machines.

## Codex (tested with codex-cli 0.157.1)

```bash
codex mcp add notion-workspace --url https://HOST/mcp
codex mcp login notion-workspace
```

## Tools

`workspace_info`, `search`, `list_pages`, `read_page`, `create_page`, `update_page`, `edit_blocks`,
`archive_page`, `restore_page`, `list_databases`, `get_database`, `query_records`, `create_database`,
`update_database_schema`, `create_record`, `update_record`, `list_comments`, `add_comment`.

- Every result includes stable ids, the app URL, and revisions. Lists are cursor-paginated.
- Creates accept `idempotencyKey`; retrying with the same key returns the first result.
- `edit_blocks` ops: `insert`, `replace`, `update_text`, `delete`, `move`, `set_checked`. `replace`,
  `update_text` and `delete` need `expectedRevision` from `read_page`; a changed page returns
  `conflict`. Edits are applied inside the page's Durable Object and appear live in open editors.
- Errors are structured: `{ "error": { "code": "not_found" | "conflict" | "forbidden" | … } }`.
- Page content is user data. The server never treats it as instructions, and the tool descriptions tell
  the model the same.

## Verification record

Local (2026-10-26, `wrangler dev`, isolated state), both clients registering through dynamic client
registration:

| Client | Login | Tools exercised | Result |
|--------|-------|-----------------|--------|
| Codex 0.157.1 (`codex mcp add` + `codex mcp login`) | OAuth, consent approved for read/write/archive | `workspace_info`, `create_page` (idempotencyKey), `read_page` | page created with block ids, revision 1 |
| Claude Code 2.1.306 (`claude mcp add --scope project` + `claude mcp login`; status ✔ Connected) | OAuth, consent approved for read/write | `workspace_info`, `search`, `read_page`, `edit_blocks` | found the Codex page, appended a paragraph, revision 2 |

Server check afterwards: the page body was `[bulletList "first item from Codex", paragraph "Appended by Claude Code"]`
and both agent connections showed in Agent connections with last-use times.

Findings: Codex prefers a Client ID Metadata Document (`https://chatgpt.com/oauth/codex/client.json`), but
chatgpt.com answers workerd's fetch with HTTP 403, so CIMD is off by default (`OAUTH_CIMD`) and Codex falls
back to dynamic registration. MCP SDK v2's per-tool `scopeChallenge` only fires on the 2026 protocol path, so
the Worker checks `tools/call` scopes before dispatch and returns the standard 403 `insufficient_scope`
challenge for every client.

Production (2026-10-27, `https://workspace.paragonxplays.workers.dev`, owner signed in with Google):

| Client | Login | Tools exercised | Result |
|--------|-------|-----------------|--------|
| Claude Code 2.1.306 (`claude mcp add --scope local notion-workspace` + `claude mcp login --no-browser`; ✔ Connected) | OAuth, consent approved for read/write | `workspace_info`, `create_page` (idempotencyKey), `read_page` | page "MCP check (Claude Code)" created, revision 1 |
| Codex 0.157.1 (`codex mcp add notion-workspace` + `codex mcp login --no-browser`) | OAuth, consent approved for read/write; "Authentication complete" | not run: the ChatGPT account hit its Codex usage limit | login only |

Finding: the first deployed attempt failed in Chrome. The consent page sent `form-action 'self'`, and Chrome
applies `form-action` to the redirect after the POST, so the 302 to `http://localhost:<port>/callback` was
blocked (the Worker logged the grant; the browser never reached the client). The consent page now also allows
the requesting client's redirect origin (`test/mcp.test.ts` asserts it). Claude Code reserves the server name
`workspace`, so the docs and Settings use `notion-workspace`.

## Compatibility

Server: `agents` 0.30.1 `createMcpHandler` with `@modelcontextprotocol/server` 2.3.1 (MCP SDK v2),
serving draft protocol `2026-07-28` stateless clients and 2025-era Streamable HTTP clients on the same
endpoint. No SSE transport, no per-session Durable Object.
