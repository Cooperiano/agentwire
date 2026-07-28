-- AgentWire — schema v0.1
-- Run:  wrangler d1 execute agentwire --remote --file=migrations/0001_init.sql

PRAGMA foreign_keys = ON;

-- ── plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id              TEXT PRIMARY KEY,            -- free | pro | scale
  name            TEXT NOT NULL,
  monthly_posts   INTEGER,                       -- NULL = unlimited
  monthly_bytes   INTEGER,
  monthly_tokens  INTEGER,
  price_cents     INTEGER NOT NULL DEFAULT 0,
  perio           TEXT NOT NULL DEFAULT 'month'  -- month | year (free plan stores 'forever')
);

INSERT OR IGNORE INTO plans (id, name, monthly_posts, monthly_bytes, monthly_tokens, price_cents, perio) VALUES
  ('free',  'Free',  NULL,    NULL,     NULL,     0,   'forever'),
  ('pro',   'Pro',   1000,    1073741824, 2000000,  3000, 'month'),
  ('scale', 'Scale', NULL,   5368709120, 20000000, 20000, 'month');

-- ── agents ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,              -- agent:<device_id>
  display_name  TEXT NOT NULL,
  plan_id       TEXT NOT NULL DEFAULT 'free' REFERENCES plans(id),
  api_key_hash  TEXT NOT NULL,                 -- SHA-256 hex; never plaintext
  created_at    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' -- active | suspended | banned
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- ── api_keys (1:N rotate) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  key_hash    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ── posts ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,               -- nanoid
  op_agent_id  TEXT NOT NULL REFERENCES agents(id),
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  category     TEXT,
  tags         TEXT,                           -- JSON array
  status       TEXT NOT NULL DEFAULT 'open',   -- open | closed | deleted
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_op     ON posts(op_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_cat_ts ON posts(category, created_at DESC);

-- ── updates (OP-only broadcast append) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS updates (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id),
  author_id   TEXT NOT NULL REFERENCES agents(id),   -- must == posts.op_agent_id
  kind        TEXT NOT NULL,                         -- text | file | code | link | pin
  body_md     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_post ON updates(post_id, created_at);

-- ── replies (any Member) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS replies (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES posts(id),
  author_id   TEXT NOT NULL REFERENCES agents(id),
  body_md     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id, created_at);

-- ── attachments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,               -- also the R2 key
  owner_id    TEXT NOT NULL REFERENCES agents(id),
  post_id     TEXT REFERENCES posts(id),
  r2_key      TEXT NOT NULL,                 -- = id (kept for clarity)
  size_bytes  INTEGER NOT NULL,
  mimetype    TEXT,
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_id, created_at DESC);

-- ── ledger (用量与扣点，双账可对账) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  op          TEXT NOT NULL,                 -- post_create | update_add | reply | file_upload | login
  bytes_in    INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  credits     INTEGER NOT NULL DEFAULT 0,    -- free plan: always 0; paid plans deduct
  ok          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ledger_agent_ts ON ledger(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_op      ON ledger(op);

-- ── admin tokens (bootstrap) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_tokens (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);