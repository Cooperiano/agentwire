-- migrations/0003_marketplace.sql — AgentWire commerce MVP
-- Shops and products are public discovery surfaces. Orders remain visible only
-- to the buyer, seller, and operator. Money movement stays with a licensed
-- payment provider; this schema stores provider references and business state.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  id              TEXT PRIMARY KEY,
  owner_agent_id  TEXT NOT NULL UNIQUE REFERENCES agents(id),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'closed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shops_status_updated
  ON shops(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  shop_id         TEXT NOT NULL REFERENCES shops(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  product_type    TEXT NOT NULL
                  CHECK (product_type IN ('digital', 'subscription', 'capability', 'task')),
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  currency        TEXT NOT NULL DEFAULT 'CNY',
  delivery_mode   TEXT NOT NULL DEFAULT 'agent'
                  CHECK (delivery_mode IN ('instant', 'agent', 'manual')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_shop_status
  ON products(shop_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_discovery
  ON products(status, product_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES products(id),
  shop_id         TEXT NOT NULL REFERENCES shops(id),
  buyer_agent_id  TEXT NOT NULL REFERENCES agents(id),
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency        TEXT NOT NULL,
  requirements    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL
                  CHECK (status IN (
                    'awaiting_payment', 'paid', 'processing', 'delivered',
                    'accepted', 'completed', 'cancelled', 'refunding',
                    'refunded', 'disputed'
                  )),
  payment_status  TEXT NOT NULL
                  CHECK (payment_status IN ('not_required', 'pending', 'paid', 'refunding', 'refunded', 'failed')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  delivered_at    INTEGER,
  accepted_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_buyer_updated
  ON orders(buyer_agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_seller_updated
  ON orders(seller_agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_updated
  ON orders(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id                      TEXT PRIMARY KEY,
  order_id                TEXT NOT NULL REFERENCES orders(id),
  provider                TEXT NOT NULL,
  provider_transaction_id TEXT,
  idempotency_key         TEXT NOT NULL UNIQUE,
  amount_cents            INTEGER NOT NULL,
  currency                TEXT NOT NULL,
  status                  TEXT NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_tx
  ON payments(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_order
  ON payments(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  body_md         TEXT NOT NULL DEFAULT '',
  attachment_id   TEXT REFERENCES attachments(id),
  content_hash    TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_order
  ON deliveries(order_id, created_at ASC);

