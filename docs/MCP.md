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
claude mcp add --transport http --scope project workspace https://HOST/mcp
claude mcp login workspace        # or run /mcp inside Claude Code and choose Authenticate
```

`--scope project` writes `.mcp.json` in the current project. `claude mcp login --no-browser` prints the
authorization URL for headless machines.

## Codex (tested with codex-cli 0.157.1)

```bash
codex mcp add workspace --url https://HOST/mcp
codex mcp login workspace
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

## Compatibility

Server: `agents` 0.30.1 `createMcpHandler` with `@modelcontextprotocol/server` 2.3.1 (MCP SDK v2),
serving draft protocol `2026-07-28` stateless clients and 2025-era Streamable HTTP clients on the same
endpoint. No SSE transport, no per-session Durable Object.
