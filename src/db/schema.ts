/**
 * Canonical SQLite schema for the MCP Guard Gateway.
 *
 * Applied idempotently at startup (and to in-memory DBs in tests). The tables are
 * split into two concerns:
 *   - operational records: `audit`, `approvals` (same shape as the D1 design)
 *   - configuration/state: `upstreams`, `policies`, `tools`, `trust`, `settings`,
 *     `clients`, `secrets` (managed via the admin API / Angular UI)
 */

export const SCHEMA = `
-- operational ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  caller_id       TEXT NOT NULL,
  tool            TEXT NOT NULL,
  args            TEXT NOT NULL,
  reason          TEXT,
  decision        TEXT NOT NULL,
  approved_by     TEXT,
  upstream_status TEXT,
  expires_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit (ts);
CREATE INDEX IF NOT EXISTS idx_audit_tool   ON audit (tool);
CREATE INDEX IF NOT EXISTS idx_audit_caller ON audit (caller_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                 TEXT PRIMARY KEY,
  tool               TEXT NOT NULL,
  args               TEXT NOT NULL,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL,
  timeout_action     TEXT,
  ttl_minutes        INTEGER,
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  result             TEXT,
  hermes_message_key TEXT,
  hermes_user_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status  ON approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_created ON approvals (created_at);

-- configuration ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS upstreams (
  id               TEXT PRIMARY KEY,
  namespace        TEXT UNIQUE NOT NULL,   -- tool prefix, e.g. 'nanokvm'
  display_name     TEXT NOT NULL,
  url              TEXT NOT NULL,
  protocol_version TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  drift_action     TEXT NOT NULL DEFAULT 'block',  -- log | notify | block
  header_map       TEXT NOT NULL DEFAULT '{}',     -- JSON: header name -> static value
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  upstream      TEXT NOT NULL REFERENCES upstreams(namespace) ON DELETE CASCADE,
  tool          TEXT NOT NULL,             -- namespaced tool name; or '*' = upstream default
  enabled       INTEGER NOT NULL DEFAULT 1,
  guard         TEXT NOT NULL DEFAULT 'none',  -- none | reason | hitl
  timeout_action TEXT,
  ttl_minutes   INTEGER,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (upstream, tool)
);

CREATE TABLE IF NOT EXISTS trust (
  upstream    TEXT PRIMARY KEY REFERENCES upstreams(namespace) ON DELETE CASCADE,
  pinned_hash TEXT NOT NULL,
  snapshot    TEXT NOT NULL,               -- JSON baseline
  pinned_at   TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'ok'   -- ok | drift | error
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,            -- client id for machine auth
  name        TEXT NOT NULL,
  secret_hash TEXT,                        -- bcrypt/scrypt hash of the service token
  scopes      TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name            TEXT PRIMARY KEY,        -- e.g. 'NANOKVM_API_KEY'
  value_ciphertext TEXT NOT NULL,           -- AES-256-GCM under SECRET_MASTER_KEY
  created_at      TEXT NOT NULL
);
`;
