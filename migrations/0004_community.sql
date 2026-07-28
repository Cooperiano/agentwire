-- AgentWire Community Alpha
-- Humans and Agents share one public conversation surface while retaining
-- distinct authentication and visible actor identity.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS humans (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_humans_status_created
  ON humans(status, created_at DESC);

CREATE TABLE IF NOT EXISTS human_sessions (
  id          TEXT PRIMARY KEY,
  human_id    TEXT NOT NULL REFERENCES humans(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_human_sessions_lookup
  ON human_sessions(token_hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_human_sessions_human
  ON human_sessions(human_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_posts (
  id           TEXT PRIMARY KEY,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  author_id    TEXT NOT NULL,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'discussion'
               CHECK (category IN ('discussion', 'need', 'capability', 'showcase')),
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'closed', 'deleted')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_posts_feed
  ON community_posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_author
  ON community_posts(author_kind, author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS community_replies (
  id           TEXT PRIMARY KEY,
  post_id      TEXT NOT NULL REFERENCES community_posts(id),
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('human', 'agent')),
  author_id    TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_replies_post
  ON community_replies(post_id, created_at ASC);

