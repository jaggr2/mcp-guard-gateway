/**
 * Canonical SQLite schema for Warden (AI Control Plane & MCP/LLM/Sandbox Gateway).
 *
 * Applied idempotently at startup (and to in-memory DBs in tests).
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
  secret_hash TEXT,                        -- sha256 hash of the service token
  scopes      TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name            TEXT PRIMARY KEY,        -- e.g. 'NANOKVM_API_KEY', 'OPENCODE_GO_API_KEY'
  value_ciphertext TEXT NOT NULL,           -- AES-256-GCM under SECRET_MASTER_KEY
  created_at      TEXT NOT NULL
);

-- OpenCode project sandboxes ---------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  slug                 TEXT PRIMARY KEY,   -- e.g. 'rsearch', 'calendar-m365-google-sync'
  display_name         TEXT NOT NULL,
  repo_url             TEXT NOT NULL,
  template             TEXT NOT NULL DEFAULT 'import',     -- import | fullstack | cdk | minimal
  lifecycle_mode       TEXT NOT NULL DEFAULT 'auto-stop',  -- auto-stop | always-on
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 120,
  daily_budget_usd     REAL NOT NULL DEFAULT 5.0,
  monthly_budget_usd   REAL NOT NULL DEFAULT 30.0,
  hourly_token_cap     INTEGER NOT NULL DEFAULT 500000,
  daily_token_cap      INTEGER NOT NULL DEFAULT 2500000,
  aws_role_arn         TEXT,
  aws_deploy_role_arn  TEXT,
  allowed_upstreams    TEXT NOT NULL DEFAULT '*',          -- CSV of allowed MCP namespaces or '*'
  token_hash           TEXT,                               -- sha256 of SANDBOX_TOKEN
  status               TEXT NOT NULL DEFAULT 'stopped',    -- running | stopped | provisioning
  branch               TEXT NOT NULL DEFAULT 'main',
  dirty_files          INTEGER NOT NULL DEFAULT 0,
  last_active_at       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- LLM cost & subscription quota ledger -----------------------------------------
CREATE TABLE IF NOT EXISTS llm_usage (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               TEXT NOT NULL,
  project          TEXT NOT NULL,
  provider         TEXT NOT NULL,          -- opencode-go | anthropic | openai | openrouter
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cached_tokens    INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0.0,
  latency_ms       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ok',
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts      ON llm_usage (ts);
CREATE INDEX IF NOT EXISTS idx_llm_usage_project ON llm_usage (project, ts);

-- Central memory & learn-skill submissions (jaggr2/agent-memory) ---------------
CREATE TABLE IF NOT EXISTS learnings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL,
  source_project TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- gotcha | memory | skill
  target_path    TEXT NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'append',
  rationale      TEXT,
  status         TEXT NOT NULL DEFAULT 'committed', -- committed | pr-open | rejected
  commit_ref     TEXT
);
CREATE INDEX IF NOT EXISTS idx_learnings_ts ON learnings (ts);

-- Scheduled agent jobs (Warden Cron — replaces Hermes Cron) --------------------
CREATE TABLE IF NOT EXISTS schedules (
  id                TEXT PRIMARY KEY,
  name              TEXT UNIQUE NOT NULL,
  cron_expr         TEXT NOT NULL,
  project           TEXT NOT NULL DEFAULT 'system',
  model             TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
  prompt            TEXT NOT NULL,
  allowed_upstreams TEXT NOT NULL DEFAULT '*',
  delivery_target   TEXT NOT NULL DEFAULT 'ha_notify',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  last_status       TEXT,
  last_output       TEXT,
  created_at        TEXT NOT NULL
);
`;
