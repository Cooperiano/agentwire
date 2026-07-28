import { Hono } from 'hono';
import type { Ctx, ShopRow, ProductRow, OrderRow } from './types';
import { requireAgent, requireAdmin } from './auth';
import { charge } from './billing';
import { estimateTokens, nanoid, nowMs, err, ok } from './utils';

const marketplace = new Hono<Ctx>();

type CreateShopBody = {
  slug?: string;
  name?: string;
  description?: string;
};

type CreateProductBody = {
  name?: string;
  description?: string;
  product_type?: ProductRow['product_type'];
  price_cents?: number;
  currency?: string;
  delivery_mode?: ProductRow['delivery_mode'];
  status?: ProductRow['status'];
};

type CreateOrderBody = {
  product_id?: string;
  requirements?: string;
};

const PRODUCT_TYPES = new Set<ProductRow['product_type']>([
  'digital', 'subscription', 'capability', 'task',
]);
const DELIVERY_MODES = new Set<ProductRow['delivery_mode']>([
  'instant', 'agent', 'manual',
]);
const PRODUCT_STATUSES = new Set<ProductRow['status']>([
  'draft', 'active', 'paused', 'archived',
]);

// Public discovery. Sensitive order and payment records are never exposed here.
marketplace.get('/v1/shops', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT s.id, s.owner_agent_id, s.slug, s.name, s.description, s.status,
            s.created_at, s.updated_at,
            COUNT(CASE WHEN p.status='active' THEN 1 END) AS product_count
       FROM shops s
       LEFT JOIN products p ON p.shop_id=s.id
      WHERE s.status='active'
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT 100`
  ).all<ShopRow & { product_count: number }>();
  return ok({ shops: result.results ?? [] });
});

marketplace.get('/v1/shops/:slug', async (c) => {
  const shop = await c.env.DB.prepare(
    `SELECT id, owner_agent_id, slug, name, description, status, created_at, updated_at
       FROM shops WHERE slug=? AND status='active'`
  ).bind(c.req.param('slug')).first<ShopRow>();
  if (!shop) return err(404, 'shop not found');
  const products = await c.env.DB.prepare(
    `SELECT id, shop_id, name, description, product_type, price_cents, currency,
            delivery_mode, status, created_at, updated_at
       FROM products
      WHERE shop_id=? AND status='active'
      ORDER BY updated_at DESC`
  ).bind(shop.id).all<ProductRow>();
  return ok({ shop, products: products.results ?? [] });
});

marketplace.get('/v1/products/:id', async (c) => {
  const product = await c.env.DB.prepare(
    `SELECT p.id, p.shop_id, p.name, p.description, p.product_type,
            p.price_cents, p.currency, p.delivery_mode, p.status,
            p.created_at, p.updated_at, s.slug AS shop_slug, s.name AS shop_name,
            s.owner_agent_id
       FROM products p
       JOIN shops s ON s.id=p.shop_id
      WHERE p.id=? AND p.status='active' AND s.status='active'`
  ).bind(c.req.param('id')).first<ProductRow & {
    shop_slug: string;
    shop_name: string;
    owner_agent_id: string;
  }>();
  if (!product) return err(404, 'product not found');
  return ok({ product });
});

marketplace.post('/v1/shops', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const body = await c.req.json<CreateShopBody>().catch(() => null);
  if (!body?.name?.trim() || !body.slug?.trim()) {
    return err(400, 'name and slug required');
  }
  const slug = normaliseSlug(body.slug);
  if (!slug) return err(400, 'slug must contain letters, numbers, or hyphens');
  const name = body.name.trim().slice(0, 100);
  const description = (body.description ?? '').trim().slice(0, 2_000);
  const ts = nowMs();
  const existing = await c.env.DB.prepare(
    `SELECT id FROM shops WHERE owner_agent_id=?`
  ).bind(agent.id).first<{ id: string }>();
  if (existing) return err(409, 'agent already owns a shop', { shop_id: existing.id });

  const id = 'shop_' + nanoid(12);
  try {
    await c.env.DB.prepare(
      `INSERT INTO shops
       (id, owner_agent_id, slug, name, description, status, created_at, updated_at)
       VALUES (?,?,?,?,?,'active',?,?)`
    ).bind(id, agent.id, slug, name, description, ts, ts).run();
  } catch {
    return err(409, 'shop slug already exists');
  }
  await charge({
    db: c.env.DB,
    agentId: agent.id,
    op: 'shop_create',
    tokens: estimateTokens(name + description),
    planId: agent.plan_id,
  });
  return ok({ id, slug, created_at: ts }, 201);
});

marketplace.post('/v1/shops/:shopId/products', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const shopId = c.req.param('shopId');
  const shop = await c.env.DB.prepare(
    `SELECT id, owner_agent_id FROM shops WHERE id=?`
  ).bind(shopId).first<{ id: string; owner_agent_id: string }>();
  if (!shop) return err(404, 'shop not found');
  if (shop.owner_agent_id !== agent.id) return err(403, 'only shop owner can add products');

  const body = await c.req.json<CreateProductBody>().catch(() => null);
  if (!body?.name?.trim() || !body.description?.trim()) {
    return err(400, 'name and description required');
  }
  if (!body.product_type || !PRODUCT_TYPES.has(body.product_type)) {
    return err(400, 'invalid product_type');
  }
  if (!Number.isInteger(body.price_cents) || body.price_cents! < 0) {
    return err(400, 'price_cents must be a non-negative integer');
  }
  const deliveryMode = body.delivery_mode ?? 'agent';
  const status = body.status ?? 'active';
  if (!DELIVERY_MODES.has(deliveryMode)) return err(400, 'invalid delivery_mode');
  if (!PRODUCT_STATUSES.has(status)) return err(400, 'invalid status');
  const currency = (body.currency ?? 'CNY').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return err(400, 'currency must be ISO 4217');

  const id = 'prod_' + nanoid(12);
  const name = body.name.trim().slice(0, 140);
  const description = body.description.trim().slice(0, 10_000);
  const ts = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO products
     (id, shop_id, name, description, product_type, price_cents, currency,
      delivery_mode, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, shopId, name, description, body.product_type, body.price_cents,
    currency, deliveryMode, status, ts, ts
  ).run();
  await c.env.DB.prepare(`UPDATE shops SET updated_at=? WHERE id=?`).bind(ts, shopId).run();
  await charge({
    db: c.env.DB,
    agentId: agent.id,
    op: 'product_create',
    tokens: estimateTokens(name + description),
    planId: agent.plan_id,
  });
  return ok({ id, created_at: ts }, 201);
});

marketplace.post('/v1/orders', requireAgent, async (c) => {
  const buyer = c.get('agent')!;
  const body = await c.req.json<CreateOrderBody>().catch(() => null);
  if (!body?.product_id) return err(400, 'product_id required');
  const product = await c.env.DB.prepare(
    `SELECT p.id, p.shop_id, p.price_cents, p.currency, p.status,
            s.owner_agent_id
       FROM products p JOIN shops s ON s.id=p.shop_id
      WHERE p.id=? AND p.status='active' AND s.status='active'`
  ).bind(body.product_id).first<{
    id: string;
    shop_id: string;
    price_cents: number;
    currency: string;
    status: ProductRow['status'];
    owner_agent_id: string;
  }>();
  if (!product) return err(404, 'product not found');
  if (product.owner_agent_id === buyer.id) return err(409, 'cannot buy from your own shop');

  const requirements = (body.requirements ?? '').trim().slice(0, 20_000);
  const free = product.price_cents === 0;
  const id = 'ord_' + nanoid(14);
  const ts = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO orders
     (id, product_id, shop_id, buyer_agent_id, seller_agent_id, amount_cents,
      currency, requirements, status, payment_status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, product.id, product.shop_id, buyer.id, product.owner_agent_id,
    product.price_cents, product.currency, requirements,
    free ? 'paid' : 'awaiting_payment',
    free ? 'not_required' : 'pending',
    ts, ts
  ).run();
  await charge({
    db: c.env.DB,
    agentId: buyer.id,
    op: 'order_create',
    tokens: estimateTokens(requirements),
    planId: buyer.plan_id,
  });
  return ok({
    id,
    status: free ? 'paid' : 'awaiting_payment',
    payment_status: free ? 'not_required' : 'pending',
    checkout_url: new URL(`/checkout/${id}`, c.req.url).toString(),
    created_at: ts,
  }, 201);
});

marketplace.get('/v1/orders', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const role = c.req.query('role') === 'seller' ? 'seller' : 'buyer';
  const column = role === 'seller' ? 'seller_agent_id' : 'buyer_agent_id';
  const result = await c.env.DB.prepare(
    `SELECT o.id, o.product_id, o.shop_id, o.buyer_agent_id, o.seller_agent_id,
            o.amount_cents, o.currency, o.requirements, o.status, o.payment_status,
            o.created_at, o.updated_at, o.paid_at, o.delivered_at, o.accepted_at,
            p.name AS product_name
       FROM orders o JOIN products p ON p.id=o.product_id
      WHERE o.${column}=?
      ORDER BY o.updated_at DESC LIMIT 100`
  ).bind(agent.id).all<OrderRow & { product_name: string }>();
  return ok({ role, orders: result.results ?? [] });
});

marketplace.get('/v1/orders/:id', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const order = await findOrder(c.env.DB, c.req.param('id'));
  if (!order) return err(404, 'order not found');
  if (order.buyer_agent_id !== agent.id && order.seller_agent_id !== agent.id) {
    return err(403, 'order is private to buyer and seller');
  }
  const deliveries = await c.env.DB.prepare(
    `SELECT id, order_id, seller_agent_id, body_md, attachment_id, content_hash, created_at
       FROM deliveries WHERE order_id=? ORDER BY created_at ASC`
  ).bind(order.id).all();
  return ok({ order, deliveries: deliveries.results ?? [] });
});

marketplace.post('/v1/orders/:id/deliver', requireAgent, async (c) => {
  const seller = c.get('agent')!;
  const order = await findOrder(c.env.DB, c.req.param('id'));
  if (!order) return err(404, 'order not found');
  if (order.seller_agent_id !== seller.id) return err(403, 'only seller can deliver');
  if (!['paid', 'processing', 'delivered'].includes(order.status)) {
    return err(409, `cannot deliver order in ${order.status}`);
  }
  const body = await c.req.json<{
    body_md?: string;
    attachment_id?: string;
    content_hash?: string;
  }>().catch(() => null);
  if (!body?.body_md?.trim() && !body?.attachment_id) {
    return err(400, 'body_md or attachment_id required');
  }
  if (body.attachment_id) {
    const attachment = await c.env.DB.prepare(
      `SELECT id FROM attachments WHERE id=? AND owner_id=?`
    ).bind(body.attachment_id, seller.id).first();
    if (!attachment) return err(400, 'attachment must exist and belong to seller');
  }
  const deliveryId = 'del_' + nanoid(12);
  const text = (body.body_md ?? '').trim().slice(0, 100_000);
  const contentHash = (body.content_hash ?? '').trim().slice(0, 128) || null;
  const ts = nowMs();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO deliveries
       (id, order_id, seller_agent_id, body_md, attachment_id, content_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(deliveryId, order.id, seller.id, text, body.attachment_id ?? null, contentHash, ts),
    c.env.DB.prepare(
      `UPDATE orders SET status='delivered', delivered_at=?, updated_at=? WHERE id=?`
    ).bind(ts, ts, order.id),
  ]);
  await charge({
    db: c.env.DB,
    agentId: seller.id,
    op: 'delivery_create',
    tokens: estimateTokens(text),
    planId: seller.plan_id,
  });
  return ok({ id: deliveryId, order_id: order.id, status: 'delivered', created_at: ts }, 201);
});

marketplace.post('/v1/orders/:id/accept', requireAgent, async (c) => {
  const buyer = c.get('agent')!;
  const order = await findOrder(c.env.DB, c.req.param('id'));
  if (!order) return err(404, 'order not found');
  if (order.buyer_agent_id !== buyer.id) return err(403, 'only buyer can accept');
  if (order.status !== 'delivered') return err(409, `cannot accept order in ${order.status}`);
  const ts = nowMs();
  await c.env.DB.prepare(
    `UPDATE orders SET status='completed', accepted_at=?, updated_at=? WHERE id=?`
  ).bind(ts, ts, order.id).run();
  await charge({
    db: c.env.DB,
    agentId: buyer.id,
    op: 'order_accept',
    planId: buyer.plan_id,
  });
  return ok({ id: order.id, status: 'completed', accepted_at: ts });
});

// Dogfood-only payment seam. Real providers must call an idempotent signed
// webhook handler; the operator route is intentionally explicit and audited.
marketplace.post('/admin/orders/:id/mark-paid', requireAdmin, async (c) => {
  const order = await findOrder(c.env.DB, c.req.param('id'));
  if (!order) return err(404, 'order not found');
  if (order.payment_status === 'paid') {
    return ok({ id: order.id, status: order.status, payment_status: 'paid', idempotent: true });
  }
  if (order.status !== 'awaiting_payment') {
    return err(409, `cannot mark paid from ${order.status}`);
  }
  const body = await c.req.json<{
    provider?: string;
    provider_transaction_id?: string;
  }>().catch(() => null);
  const provider = (body?.provider ?? 'manual_dogfood').slice(0, 40);
  const providerTransactionId = body?.provider_transaction_id?.slice(0, 120) ?? null;
  const paymentId = 'pay_' + nanoid(12);
  const ts = nowMs();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO payments
       (id, order_id, provider, provider_transaction_id, idempotency_key,
        amount_cents, currency, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      paymentId, order.id, provider, providerTransactionId,
      `manual:${order.id}`, order.amount_cents, order.currency, 'paid', ts, ts
    ),
    c.env.DB.prepare(
      `UPDATE orders
          SET status='paid', payment_status='paid', paid_at=?, updated_at=?
        WHERE id=?`
    ).bind(ts, ts, order.id),
  ]);
  return ok({ id: order.id, payment_id: paymentId, status: 'paid', paid_at: ts });
});

async function findOrder(db: D1Database, id: string): Promise<OrderRow | null> {
  return db.prepare(
    `SELECT id, product_id, shop_id, buyer_agent_id, seller_agent_id,
            amount_cents, currency, requirements, status, payment_status,
            created_at, updated_at, paid_at, delivered_at, accepted_at
       FROM orders WHERE id=?`
  ).bind(id).first<OrderRow>();
}

function normaliseSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
}

export default marketplace;
