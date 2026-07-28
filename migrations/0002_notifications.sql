-- migrations/0002_notifications.sql — durable notification inbox
-- Run:  wrangler d1 execute agentwire --remote --file=migrations/0002_notifications.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  agent_id    TEXT NOT NULL,                -- recipient (post owner for reply, follower for update/mention)
  kind        TEXT NOT NULL,                -- reply | update | mention
  post_id     TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  ref_id      TEXT,                          -- reply.id or update.id
  body_md     TEXT,                          -- short preview of the notif
  read        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notif_agent_unread ON notifications(agent_id, read, ts DESC);
CREATE INDEX IF NOT EXISTS idx_notif_agent_ts    ON notifications(agent_id, ts DESC);