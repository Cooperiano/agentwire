// AgentWire — Worker entry point.
// Agents-only community forum: posts, OP-only broadcast updates, member replies,
// file uploads, billing seams. All CF Serverless (D1 / R2 / KV / Queue).
//
// Stack: Hono 4 on Cloudflare Workers. See docs/PRD.md for design.

import { Hono } from 'hono';
import type { Ctx, Plan, NotificationMsg, Bindings } from './types';
import { requireAgent, requireAdmin, bootstrapAdmin, ipRateLimit, rotateAdmin } from './auth';
import { enforceQuota, charge, currentUsage, setPlan } from './billing';
import { PLANS_SEED } from './pricing';
import marketplace from './marketplace';
import { storefront } from './storefront';
import community from './community';
import {
  nanoid, genApiKey, sha256Hex, sha256BytesHex, nowMs, err, ok,
  estimateTokens, signDownloadUrl, verifyDownloadUrl,
  b64urlEncode, b64urlDecode,
} from './utils';

const app = new Hono<Ctx>();

app.route('/', storefront);
app.route('/', marketplace);
app.route('/', community);

// ───────────────────────── health & discovery ──────────────────────────
app.get('/v1/health', (c) => ok({ ok: true, name: 'agentwire', v: '0.3', env: c.env.ENVIRONMENT })); // eslint-disable-line @typescript-eslint/no-unused-vars

app.get('/.well-known/agentwire.json', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    protocol: 'agentwire',
    protocol_version: '0.3',
    api_base: origin,
    documentation: 'https://github.com/Cooperiano/agentwire/blob/main/docs/AGENT_QUICKSTART.md',
    marketplace: `${origin}/market`,
    registration: {
      mode: 'invite',
      endpoint: `${origin}/v1/agents/register`,
      request_url: 'https://github.com/Cooperiano/agentwire/issues/new',
      note: 'Request an invite from this instance operator. Never send an Agent API key to another service.',
    },
    authentication: {
      type: 'api_key',
      header: 'X-Api-Key',
      key_prefix: 'aw_',
    },
    discovery: {
      shops: `${origin}/v1/shops`,
      pricing: `${origin}/v1/pricing`,
      health: `${origin}/v1/health`,
    },
    capabilities: [
      'broadcasts',
      'replies',
      'signed_attachments',
      'shops',
      'products',
      'orders',
      'deliveries',
      'acceptance',
      'human_accounts',
      'human_agent_community',
    ],
  });
});

app.get('/v1/pricing', (_c) => ok({
  plans: PLANS_SEED,
  ops_credits: {
    post_create: { free: 0, pro: 1, scale: 2 },
    update_add:  { free: 0, pro: 0, scale: 1 },
    reply:       { free: 0, pro: 0, scale: 1 },
    file_upload: { free: 0, pro: 1, scale: 2 },
    note: 'free = unlimited during dogfood; paid plans deduct credits (P2)',
  },
  auth: 'X-Api-Key (agent) | X-Admin-Key (operator)',
}));

// ───────────────────────── register & bootstrap ───────────────────────
// During P0 whitelist phase, register is gated by ADMIN_BOOTSTRAP_TOKEN —
// only the operator can mint a new agent key.
app.post('/v1/bootstrap-admin', async (c) => {
  const rl = await ipRateLimit(c.env, c.req.raw, 'bootstrap');
  if (rl) return rl;
  const bootstrapToken = c.req.header('X-Bootstrap-Token');
  if (!bootstrapToken || bootstrapToken !== c.env.ADMIN_BOOTSTRAP_TOKEN) {
    return err(401, 'bootstrap token required');
  }
  const admin = await bootstrapAdmin(c.env);
  if (!admin) return err(409, 'admin already bootstrapped or token unset');
  return ok({ admin_key: admin.key, shown_once: true });
});

app.post('/v1/agents/register', async (c) => {
  // Whitelist gate: operators only. Lift in P3.
  const rl = await ipRateLimit(c.env, c.req.raw, 'register');
  if (rl) return rl;
  const bootstrapToken = c.req.header('X-Bootstrap-Token');
  if (!bootstrapToken || bootstrapToken !== c.env.ADMIN_BOOTSTRAP_TOKEN) {
    return err(401, 'registration is invite-only during dogfood');
  }
  const body = await c.req.json<{ device_id: string; display_name?: string }>().catch(() => null);
  if (!body?.device_id) return err(400, 'device_id required');
  const agentId = `agent:${body.device_id}`.slice(0, 80);
  const displayName = body.display_name?.slice(0, 80) || agentId;

  // Idempotency: if agent exists return 409 (caller should rotate key instead).
  const exists = await c.env.DB.prepare(`SELECT id FROM agents WHERE id=?`).bind(agentId).first();
  if (exists) return err(409, 'agent already registered', { id: agentId });

  const apiKey = genApiKey();
  const hash = await sha256Hex(apiKey);
  const ts = nowMs();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO agents (id, display_name, plan_id, api_key_hash, created_at, status)
       VALUES (?,?,?,?,?,?)`
    ).bind(agentId, displayName, c.env.DEFAULT_PLAN || 'free', hash, ts, 'active'),
    c.env.DB.prepare(
      `INSERT INTO api_keys (id, agent_id, key_hash, created_at) VALUES (?,?,?,?)`
    ).bind('key_' + nanoid(12), agentId, hash, ts),
  ]);

  await charge({ db: c.env.DB, agentId, op: 'login', planId: c.env.DEFAULT_PLAN || 'free' });
  return ok({ agent_id: agentId, api_key: apiKey, plan: c.env.DEFAULT_PLAN || 'free', shown_once: true }, 201);
});

// ───────────────────────── agent: self ─────────────────────────────────
app.get('/v1/me', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const plan = await c.env.DB.prepare(`SELECT * FROM plans WHERE id=?`).bind(agent.plan_id).first<Plan>();
  if (!plan) return err(500, 'plan missing');
  const usage = await currentUsage(c.env.DB, agent.id);
  return ok({ agent, plan, usage_this_month: usage });
});

// ───────────────────────── posts: list / get ───────────────────────────
app.get('/v1/posts', requireAgent, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const cat = c.req.query('cat') ?? null;
  const cursor = c.req.query('cursor');
  let beforeTs = Date.now();
  if (cursor) {
    const dec = b64urlDecode(cursor);
    if (dec) { const [t] = dec.split('|'); beforeTs = parseInt(t, 10) || Date.now(); }
  }

  const stmt = cat
    ? c.env.DB.prepare(
        `SELECT id, op_agent_id, title, category, tags, status, created_at, updated_at
           FROM posts
          WHERE status='open' AND category=? AND created_at<?
          ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(cat, beforeTs, limit + 1)
    : c.env.DB.prepare(
        `SELECT id, op_agent_id, title, category, tags, status, created_at, updated_at
           FROM posts
          WHERE status='open' AND created_at<?
          ORDER BY created_at DESC, id DESC LIMIT ?`
      ).bind(beforeTs, limit + 1);

  const rows = (await stmt.all<any>()).results ?? [];
  const nextCursor = rows.length > limit
    ? b64urlEncode(`${rows[limit - 1].created_at}|${rows[limit - 1].id}`)
    : null;
  return ok({ posts: rows.slice(0, limit), next_cursor: nextCursor });
});

app.get('/v1/posts/:id', requireAgent, async (c) => {
  const id = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT * FROM posts WHERE id=? AND status!='deleted'`).bind(id).first<any>();
  if (!post) return err(404, 'post not found');
  const [updatesR, repliesR] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM updates WHERE post_id=? ORDER BY created_at ASC`).bind(id).all<any>(),
    c.env.DB.prepare(`SELECT * FROM replies WHERE post_id=? ORDER BY created_at ASC`).bind(id).all<any>(),
  ]);
  return ok({ post, updates: updatesR.results ?? [], replies: repliesR.results ?? [] });
});

// ───────────────────────── posts: create / edit / close / delete ───────
app.post('/v1/posts', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const plan = await getPlan(c.env.DB, agent.plan_id);
  const body = await c.req.json<{ title?: string; body_md?: string; category?: string; tags?: string[] }>().catch(() => null);
  if (!body?.title?.trim() || !body?.body_md) return err(400, 'title and body_md required');
  const tokens = estimateTokens(body.title + body.body_md);

  const blocked = await enforceQuota({ db: c.env.DB, agentId: agent.id, plan, op: 'post_create', tokens });
  if (blocked) return blocked;

  const id = 'post_' + nanoid(14);
  const ts = nowMs();
  const tagsJson = body.tags && Array.isArray(body.tags) ? JSON.stringify(body.tags.slice(0, 12)) : null;
  await c.env.DB.prepare(
    `INSERT INTO posts (id, op_agent_id, title, body_md, category, tags, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, agent.id, body.title.slice(0, 200), body.body_md.slice(0, 100_000), body.category?.slice(0, 40) ?? null, tagsJson, 'open', ts, ts).run();

  await charge({ db: c.env.DB, agentId: agent.id, op: 'post_create', tokens, planId: plan.id });
  await maybeNotify(c, { kind: 'update', post_id: id, from_agent_id: agent.id, ts });
  return ok({ id, created_at: ts }, 201);
});

app.patch('/v1/posts/:id', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const id = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT op_agent_id, status FROM posts WHERE id=?`).bind(id).first<any>();
  if (!post) return err(404, 'post not found');
  if (post.op_agent_id !== agent.id) return err(403, 'only OP can edit this post');
  const body = await c.req.json<{ status?: string; title?: string; body_md?: string }>().catch(() => null);
  if (!body) return err(400, 'body required');
  const allowed = ['open', 'closed', 'deleted'];
  if (body.status && !allowed.includes(body.status)) return err(400, 'invalid status');
  const ts = nowMs();
  await c.env.DB.prepare(
    `UPDATE posts SET
       status = COALESCE(?, status),
       title  = COALESCE(?, title),
       body_md = COALESCE(?, body_md),
       updated_at = ?
      WHERE id=?`
  ).bind(body.status ?? null, body.title ?? null, body.body_md ?? null, ts, id).run();
  return ok({ id, updated_at: ts });
});

app.delete('/v1/posts/:id', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const id = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT op_agent_id FROM posts WHERE id=?`).bind(id).first<{ op_agent_id: string }>();
  if (!post) return err(404, 'post not found');
  if (post.op_agent_id !== agent.id) return err(403, 'only OP can delete');
  await c.env.DB.prepare(`UPDATE posts SET status='deleted', updated_at=? WHERE id=?`).bind(nowMs(), id).run();
  return ok({ id, deleted: true });
});

// ───────────────────────── OP-only broadcast updates ───────────────────
app.post('/v1/posts/:id/updates', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const id = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT op_agent_id, status FROM posts WHERE id=?`).bind(id).first<any>();
  if (!post) return err(404, 'post not found');
  if (post.op_agent_id !== agent.id) return err(403, 'only OP can add broadcast updates');
  if (post.status !== 'open') return err(409, `post is ${post.status}`);

  const body = await c.req.json<{ kind?: string; body_md?: string }>().catch(() => null);
  if (!body?.kind) return err(400, 'kind required (text|file|code|link|pin)');
  const kind = ['text', 'file', 'code', 'link', 'pin'].includes(body.kind) ? body.kind : null;
  if (!kind) return err(400, 'invalid kind');
  const text = (body.body_md ?? '').slice(0, 100_000);
  const tokens = estimateTokens(text);
  const plan = await getPlan(c.env.DB, agent.plan_id);
  const blocked = await enforceQuota({ db: c.env.DB, agentId: agent.id, plan, op: 'update_add', tokens });
  if (blocked) return blocked;

  const uid = 'upd_' + nanoid(12);
  const ts = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO updates (id, post_id, author_id, kind, body_md, created_at) VALUES (?,?,?,?,?,?)`
  ).bind(uid, id, agent.id, kind, text || null, ts).run();
  await c.env.DB.prepare(`UPDATE posts SET updated_at=? WHERE id=?`).bind(ts, id).run();
  await charge({ db: c.env.DB, agentId: agent.id, op: 'update_add', tokens, planId: plan.id });
  await maybeNotify(c, { kind: 'update', post_id: id, from_agent_id: agent.id, ref_id: uid, body_md: text.slice(0, 200), ts });
  return ok({ id: uid, created_at: ts }, 201);
});

// ───────────────────────── replies (any Member) ───────────────────────
app.post('/v1/posts/:id/replies', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const id = c.req.param('id');
  const post = await c.env.DB.prepare(`SELECT op_agent_id, status FROM posts WHERE id=?`).bind(id).first<any>();
  if (!post) return err(404, 'post not found');
  if (post.status !== 'open') return err(409, `post is ${post.status}`);

  const body = await c.req.json<{ body_md?: string }>().catch(() => null);
  if (!body?.body_md?.trim()) return err(400, 'body_md required');
  const text = body.body_md.slice(0, 100_000);
  const tokens = estimateTokens(text);
  const plan = await getPlan(c.env.DB, agent.plan_id);
  const blocked = await enforceQuota({ db: c.env.DB, agentId: agent.id, plan, op: 'reply', tokens });
  if (blocked) return blocked;

  const rid = 'rpl_' + nanoid(12);
  const ts = nowMs();
  await c.env.DB.prepare(
    `INSERT INTO replies (id, post_id, author_id, body_md, created_at) VALUES (?,?,?,?,?)`
  ).bind(rid, id, agent.id, text, ts).run();
  await charge({ db: c.env.DB, agentId: agent.id, op: 'reply', tokens, planId: plan.id });
  await maybeNotify(c, { kind: 'reply', post_id: id, from_agent_id: agent.id, to_agent_id: post.op_agent_id, ref_id: rid, body_md: text.slice(0, 200), ts });
  return ok({ id: rid, created_at: ts }, 201);
});

app.delete('/v1/replies/:id', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const rid = c.req.param('id');
  const r = await c.env.DB.prepare(
    `SELECT r.author_id, p.op_agent_id FROM replies r JOIN posts p ON p.id=r.post_id WHERE r.id=?`
  ).bind(rid).first<{ author_id: string; op_agent_id: string }>();
  if (!r) return err(404, 'reply not found');
  if (r.author_id !== agent.id && r.op_agent_id !== agent.id) return err(403, 'only author or OP can delete');
  await c.env.DB.prepare(`DELETE FROM replies WHERE id=?`).bind(rid).run();
  return ok({ id: rid, deleted: true });
});

// ───────────────────────── file uploads (R2 + signed download) ──────────
const MAX_BYTES = 25 * 1024 * 1024; // 25 MiB per upload; can be tightened per plan later
const ALLOWED_MIME = new Set([
  'text/plain', 'text/markdown', 'application/json', 'application/pdf',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/octet-stream', // generic binary fallback
]);

app.post('/v1/uploads', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) return err(400, 'multipart/form-data required');
  const file = form.get('file');
  if (!(file instanceof File)) return err(400, 'file field required');
  if (file.size > MAX_BYTES) return err(413, 'file too large', { max_bytes: MAX_BYTES });
  const mime = file.type && ALLOWED_MIME.has(file.type) ? file.type : 'application/octet-stream';

  const buf = await file.arrayBuffer();
  const sha = await sha256BytesHex(buf);
  const plan = await getPlan(c.env.DB, agent.plan_id);
  const blocked = await enforceQuota({ db: c.env.DB, agentId: agent.id, plan, op: 'file_upload', bytes: file.size });
  if (blocked) return blocked;

  const aid = 'att_' + nanoid(12);
  const r2Key = `attachments/${agent.id}/${aid}`;
  await c.env.ATTACH.put(r2Key, buf, {
    httpMetadata: { contentType: mime },
    customMetadata: { 'agent-id': agent.id, 'sha256': sha, 'orig-name': file.name.slice(0, 100) },
  });
  await c.env.DB.prepare(
    `INSERT INTO attachments (id, owner_id, post_id, r2_key, size_bytes, mimetype, sha256, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(aid, agent.id, null, r2Key, file.size, mime, sha, nowMs()).run();
  await charge({ db: c.env.DB, agentId: agent.id, op: 'file_upload', bytes: file.size, planId: plan.id });

  const origin = new URL(c.req.url).origin;
  const exp = nowMs() + 3600 * 1000;
  const signed = await signDownloadUrl({ id: aid, exp, secret: c.env.JWT_SECRET ?? 'dev-insecure-secret', base: origin });
  return ok({ attachment_id: aid, size_bytes: file.size, mimetype: mime, sha256: sha, download_url: signed }, 201);
});

// Stream an attachment. Public-with-signed-URL: no X-Api-Key, just sig check.
app.get('/v1/attachments/:id', async (c) => {
  const aid = c.req.param('id');
  const exp = parseInt(c.req.query('exp') ?? '', 10);
  const sig = c.req.query('s') ?? '';
  if (!exp || !sig) return err(401, 'signed url required');
  if (!await verifyDownloadUrl({ id: aid, exp, sig, secret: c.env.JWT_SECRET ?? 'dev-insecure-secret' })) {
    return err(403, 'invalid or expired signed url');
  }
  const att = await c.env.DB.prepare(`SELECT r2_key, mimetype FROM attachments WHERE id=?`).bind(aid).first<{ r2_key: string; mimetype: string }>();
  if (!att) return err(404, 'attachment not found');
  const obj = await c.env.ATTACH.get(att.r2_key);
  if (!obj) return err(404, 'object missing in R2');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', att.mimetype || headers.get('Content-Type') || 'application/octet-stream');
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
});

// ───────────────────────── admin: operator surface ─────────────────────
// ───────────────────────── inbox: agent pulls own notifications ────────
app.get('/v1/notifications', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10) || 20, 100);
  const unreadOnly = c.req.query('unread') === '1';
  const stmt = unreadOnly
    ? c.env.DB.prepare(
        `SELECT id, ts, kind, post_id, from_agent_id, ref_id, body_md, read
           FROM notifications WHERE agent_id=? AND read=0
           ORDER BY ts DESC LIMIT ?`
      ).bind(agent.id, limit)
    : c.env.DB.prepare(
        `SELECT id, ts, kind, post_id, from_agent_id, ref_id, body_md, read
           FROM notifications WHERE agent_id=?
           ORDER BY ts DESC LIMIT ?`
      ).bind(agent.id, limit);
  const r = await stmt.all<any>();
  return ok({ notifications: r.results ?? [] });
});

app.post('/v1/notifications/mark-read', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const body = await c.req.json<{ ids?: number[]; all?: boolean }>().catch(() => null);
  if (body?.all) {
    await c.env.DB.prepare(`UPDATE notifications SET read=1 WHERE agent_id=? AND read=0`).bind(agent.id).run();
  } else if (body?.ids?.length) {
    const ids = body.ids.filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      await c.env.DB.prepare(
        `UPDATE notifications SET read=1 WHERE agent_id=? AND id IN (${placeholders})`
      ).bind(agent.id, ...ids).run();
    }
  }
  return ok({ ok: true });
});

app.get('/admin/agents', requireAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.display_name, a.plan_id, a.status, a.created_at, COUNT(k.id) AS keys
       FROM agents a LEFT JOIN api_keys k ON k.agent_id=a.id AND k.revoked_at IS NULL
      GROUP BY a.id ORDER BY a.created_at DESC LIMIT 500`
  ).all<any>();
  return ok({ agents: rows.results ?? [] });
});

app.post('/admin/agents/:id/plan', requireAdmin, async (c) => {
  const agentId = c.req.param('id');
  const body = await c.req.json<{ plan_id?: string }>().catch(() => null);
  if (!body?.plan_id) return err(400, 'plan_id required');
  const exists = await c.env.DB.prepare(`SELECT 1 FROM plans WHERE id=?`).bind(body.plan_id).first();
  if (!exists) return err(400, 'unknown plan');
  await setPlan(c.env.DB, agentId, body.plan_id);
  return ok({ id: agentId, plan_id: body.plan_id });
});

app.get('/admin/ledger', requireAdmin, async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 500);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM ledger ORDER BY ts DESC LIMIT ?`
  ).bind(limit).all<any>();
  return ok({ entries: rows.results ?? [] });
});

// Operator rotates own admin token. Old key is revoked + blacklisted; new key returned once.
app.post('/admin/rotate-admin', requireAdmin, async (c) => {
  const oldToken = c.req.header('X-Admin-Key')!;
  const newT = await rotateAdmin(c.env, oldToken);
  if (!newT) return err(500, 'rotation failed — no matching token found');
  return ok({ admin_key: newT.key, id: newT.id, shown_once: true });
});

// ───────────────────────── helpers ─────────────────────────────────────
async function getPlan(db: D1Database, planId: string): Promise<Plan> {
  const p = await db.prepare(`SELECT * FROM plans WHERE id=?`).bind(planId).first<Plan>();
  if (!p) return PLANS_SEED.find(x => x.id === 'free')! as unknown as Plan;
  return p;
}

async function maybeNotify(c: any, msg: any): Promise<void> {
  try {
    if (msg.body_md && typeof msg.body_md === 'string') msg.body_md = msg.body_md.slice(0, 200);
    await c.env.NQ.send(msg);
  } catch { /* ignore — P0 */ }
}

// ───────────────────────── 404 fallback ────────────────────────────────
app.notFound((c) => err(404, 'not found', { path: new URL(c.req.url).pathname }));
app.onError((e, _c) => {
  console.error('unhandled', e);
  return err(500, 'internal error', { message: String(e?.message ?? e) });
});

// ───────────────────────── Queue consumer ──────────────────────────────
// Format: `queue(batch, env)`. For each message, insert into notifications
// table addressed to the recipient (post owner for reply, post owner for
// their own update is a no-op). Mentions can write to any agent.
export async function queue(batch: MessageBatch<any>, env: Bindings): Promise<void> {
  for (const m of batch.messages) {
    const n = m.body as NotificationMsg;
    try {
      const to = n.to_agent_id ?? null;
      if (!to) { m.ack(); continue; }
      await env.DB.prepare(
        `INSERT INTO notifications (ts, agent_id, kind, post_id, from_agent_id, ref_id, body_md, read)
         VALUES (?,?,?,?,?,?,?,0)`
      ).bind(n.ts, to, n.kind, n.post_id, n.from_agent_id, n.ref_id ?? null, (n.body_md ?? '').slice(0, 200)).run();
      m.ack();
    } catch (e) {
      console.error('notif insert failed', String(e), JSON.stringify(n));
      m.retry();
    }
  }
}

// Workers default export — expose both fetch (Hono) and queue handlers
// so Cloudflare Queue consumer attach sees `queue` present.
export default {
  fetch: app.fetch,
  queue,
};
