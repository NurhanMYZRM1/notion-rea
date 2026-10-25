-- Workspace metadata. Document bodies live in page Durable Objects, never here.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX invitations_workspace ON invitations(workspace_id, created_at);

-- Pages, databases and database records are all pages.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT,
  database_id TEXT,              -- set for database records
  is_database INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  position TEXT NOT NULL,        -- fractional index among siblings
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  archived_at INTEGER,
  archived_by TEXT,
  archive_root TEXT,             -- the page whose archiving archived this one
  props TEXT NOT NULL DEFAULT '{}', -- record property values (JSON)
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_tree ON pages(workspace_id, parent_id, state, position);
CREATE INDEX pages_records ON pages(database_id, state, created_at, id);
CREATE INDEX pages_archive ON pages(workspace_id, state, archived_at);

CREATE TABLE databases (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  schema TEXT NOT NULL,          -- JSON PropertyDef[]
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE database_views (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(page_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('table', 'board')),
  config TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX views_db ON database_views(database_id, position);

CREATE TABLE favorites (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE recents (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);
CREATE INDEX recents_user ON recents(user_id, workspace_id, visited_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user' CHECK (author_type IN ('user', 'agent')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX comments_page ON comments(page_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_page ON attachments(page_id);

-- Delegated agent (MCP) access. Checked on every MCP call, independent of token expiry.
CREATE TABLE agent_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,          -- space-separated
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX agent_grants_user ON agent_grants(user_id, workspace_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  actor_id TEXT,
  actor_type TEXT NOT NULL,      -- user | agent | system
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_workspace ON audit_events(workspace_id, created_at);

-- Which users have open document sockets, so revocation can reach the right page objects.
CREATE TABLE doc_sessions (
  page_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX doc_sessions_user ON doc_sessions(user_id, workspace_id);

-- Derived search projection (eventually consistent). Body text comes from the page DO outbox.
CREATE TABLE search_docs (
  rowid INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE search_fts USING fts5(
  title, body, content='search_docs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
