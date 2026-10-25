# Feature / evidence matrix

Scope: documents, databases, collaboration. Evidence was collected on 2026-10-25 from the public
marketing page and public help-center pages only. No authenticated Notion product was observed, so
nothing here describes Notion's editor internals, sync algorithm, backend, or schemas.

Evidence key:
- **E1** REA browser scenario `ev_e7215cbd3cdf0f10adf019c1adead579e5b50ed2fa8f246cdd8d524fe5f49a7a`
  (Chrome headless, 1280x900, `https://www.notion.com/product/features#capture`, 2.5 s settle).
  Retained: [screenshot](evidence/capture-page.png), [accessibility tree](evidence/capture-page.a11y.txt).
  Limits: marketing page only; no interaction, no network bodies.
- **D1** https://www.notion.com/help/writing-and-editing-basics
- **D2** https://www.notion.com/help/intro-to-databases
- **D3** https://www.notion.com/help/views-filters-and-sorts
- **D4** https://www.notion.com/help/collaborate-with-people

Status: **O** observed (E1), **D** documented (D1–D4), **I** inferred, **U** unknown.

| # | Behavior | Source | Status | Our chosen behavior | Acceptance test |
|---|----------|--------|--------|---------------------|-----------------|
| 1 | Capture section lists Docs, Databases, Real-time collaboration, AI notes, syncs, forms, imports, mobile, clipper | E1 a11y lines 28–75 | O | Implement Docs, Databases, Collaboration, Imports, Mobile. AI notes, syncs, forms, clipper are deferred and get no UI | n/a (scope) |
| 2 | Block-based docs "from a note to a full spec" | E1, D1 | O/D | Tiptap/ProseMirror blocks with stable `id` attrs, stored as one Yjs doc per page | `packages/editor` schema tests; e2e `editor.spec.ts` |
| 3 | `/` menu inserts block types and actions | D1 | D | Slash menu: text, H1–H3, bullet, numbered, task, toggle, quote, code, divider, image, file | e2e: type `/head` Enter → H1 |
| 4 | Markdown line shortcuts (`#`, `-`, `1.`, `[]`, `>`, `"`, `---`) | D1 | D | Same, except `>` makes a quote and `>>` a toggle (we keep Markdown's quote meaning) | unit: input rules |
| 5 | Drag handle `⋮⋮` reorders blocks; block menu has Turn into, Duplicate, Move to, Delete | D1 | D | Drag handle (pointer) + Alt+Shift+↑/↓ (keyboard) + block menu Duplicate/Delete/Move to page | e2e: keyboard reorder keeps block id |
| 6 | Sub-pages nested without limit; sidebar drag nests pages | D1 | D | Nested pages, sidebar tree, Move to; depth unbounded but tree loaded lazily per parent | api test: move/cycle rejection |
| 7 | Comments on pages and text, @mentions, inbox | D4 | D | Page-level comments only this release; no mentions/inbox | api + e2e comment add/list |
| 8 | Simultaneous editing, everyone sees edits immediately | D4 | D | Yjs CRDT over a per-page Durable Object WebSocket | two-browser e2e convergence |
| 9 | Presence via avatars | D4 | D | Avatar stack + colored carets (y-protocols awareness) | e2e: second user's caret visible |
| 10 | Cursors | D4 | U (not documented) | Show named carets; our choice | same as 9 |
| 11 | Page history | D4 | D | Deferred (no UI). Update log retained server-side for durability only | n/a |
| 12 | Database rows are full pages | D2 | D | Records are `pages` rows with `database_id` + property JSON and a normal Yjs body | api: record has body; MCP read |
| 13 | Table default view, multiple views, per-view filter/sort/group | D2, D3 | D | Table + Board views; per-view filters (AND only), sorts, board group-by select/status | api query tests; e2e table/board |
| 14 | Board groups by a property; drag between columns | D3 | D (move effect U) | Moving a card sets the group property to the column's option (inferred, our choice) | api + e2e card move updates property |
| 15 | Filters for self vs everyone | D3 | D | Views are shared; no personal filters this release | n/a |
| 16 | Select options sort by option order | D3 | D | Same | unit: sort compiler |
| 17 | Viewer vs editor permission levels | D2 ("Can edit content") | D (partial) | Workspace-wide owner/editor/viewer; editors may change schema/views; no per-page ACL | authz matrix tests |
| 18 | >1,000 items may insert mid-collection | D2 | D | We always order by explicit sort or `created_at, id`; keyset pagination | api: 10k-row pagination |
| 19 | Imports from other tools | E1 | O | Markdown page import/export, CSV database import/export with rejection report | unit: import fixtures |
| 20 | Mobile apps | E1 | O | Expo native shell + one embedded editor WebView (DOM component) | Maestro flows |
| 21 | MCP | features page (Automate) | D | Own MCP server at `/mcp`, OAuth, per-tool scopes | MCP tests + real client logins |

Unknowns carried forward (not needed for implementation): Notion's conflict resolution, block storage
format, offline model, and board-move semantics. Our choices above are design decisions, not recovered
internals.
