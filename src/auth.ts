// Auth — X-Api-Key → Agent lookup + KV blacklist fast-path.
//
// Strategy:
//   - agent keys: stored as SHA-256 hex (fast lookup at every API call).
//   - admin tokens: stored as PBKDF2(SHA-256, 100k iters) — slow-hash OK because
//     admin auth happens rarely (operator only); offline DB dump brute-force
//     stays expensive.
//   - KV holds a blacklist of revoked key/token hashes; fast path before DB.
//   - KV also holds IP rate-limit counters for /v1/agents/register and
//     /v1/bootstrap-admin to throttle bootstrap-token abuse.

import type { Bindings, Agent, Ctx } from './types';
import { sha256Hex, pbkdf2Hash, pbkdf2Verify, extractApiKey, err, nowMs, genApiKey, nanoid } from './utils';
import type { MiddlewareHandler } from 'hono';

/** Resolve Agent from API key on the request. */
export async function resolveAgent(env: Bindings, req: Request): Promise<Agent | null> {
  const raw = extractApiKey(req);
  if (!raw) return null;
  if (!raw.startsWith('aw_')) return null;

  const hash = await sha256Hex(raw);
  if (await env.KV.get(`revoked:${hash}`)) return null; // revoked key — short-circuit

  const row = await env.DB.prepare(
    `SELECT a.id, a.display_name, a.plan_id, a.status, a.created_at
       FROM agents a
       JOIN api_keys k ON k.agent_id = a.id
      WHERE k.key_hash=? AND k.revoked_at IS NULL AND a.status='active'
      LIMIT 1`
  ).bind(hash).first<Agent>();
  return row ?? null;
}

/** Middleware: require authenticated Agent. 401/403 if absent. */
export const requireAgent: MiddlewareHandler<Ctx> = async (c, next) => {
  const agent = await resolveAgent(c.env, c.req.raw);
  if (!agent) return err(401, 'unauthorized', {});
  c.set('agent', agent);
  await next();
};

/** Middleware: require /admin path to be called with X-Admin-Key. */
export const requireAdmin: MiddlewareHandler<Ctx> = async (c, next) => {
  const token = c.req.header('X-Admin-Key') ?? '';
  if (!token) return err(401, 'admin key required', {});
  // fast path: revoked blacklist by SHA-256 (no need to run PBKDF2 for known-bad)
  const h = await sha256Hex(token);
  if (await c.env.KV.get(`revoked_admin:${h}`)) return err(403, 'admin key revoked', {});
  // otherwise we must scan admin_tokens (one row per operator, small table)
  // and PBKDF2-verify each. Slow but rare.
  const rows = await c.env.DB.prepare(
    `SELECT id, token_hash FROM admin_tokens WHERE revoked_at IS NULL LIMIT 50`
  ).all<{ id: string; token_hash: string }>();
  let matched: { id: string } | null = null;
  for (const r of rows.results ?? []) {
    if (r.token_hash.startsWith('pbkdf2$')) {
      if (await pbkdf2Verify(token, r.token_hash)) { matched = { id: r.id }; break; }
    } else {
      // legacy SHA-256 hex row (pre-P0-hardening) — keep accepting until rotated
      if (r.token_hash === h) { matched = { id: r.id }; break; }
    }
  }
  if (!matched) return err(403, 'invalid admin key', {});
  c.set('admin', true);
  await next();
};

/** Bootstrap first admin key (one-shot). Requires ADMIN_BOOTSTRAP_TOKEN env/secret set. */
export async function bootstrapAdmin(env: Bindings): Promise<{ key: string } | null> {
  const _bootstrap = env.ADMIN_BOOTSTRAP_TOKEN;
  if (!_bootstrap) return null;
  // only if no admin_tokens exist
  const any = await env.DB.prepare(`SELECT COUNT(*) AS n FROM admin_tokens`).first<{ n: number }>();
  if (any && any.n > 0) return null;

  const key = genApiKey();
  const h = await pbkdf2Hash(key); // slow-hash stored hash
  const id = 'admin_' + nanoid(12);
  await env.DB.prepare(
    `INSERT INTO admin_tokens (id, token_hash, label, created_at) VALUES (?,?,?,?)`
  ).bind(id, h, 'bootstrap', nowMs()).run();
  return { key };
}

/** Rotate admin token: caller's X-Admin-Key revoked, new PBKDF2-hashed row minted.
 *  Old token's SHA-256 is added to KV blacklist so any future attempt 403s fast. */
export async function rotateAdmin(env: Bindings, oldToken: string): Promise<{ key: string; id: string } | null> {
  // Verify old token first (lookup row)
  const rows = await env.DB.prepare(
    `SELECT id, token_hash FROM admin_tokens WHERE revoked_at IS NULL LIMIT 50`
  ).all<{ id: string; token_hash: string }>();
  let matched: { id: string; token_hash: string } | null = null;
  for (const r of rows.results ?? []) {
    if (r.token_hash.startsWith('pbkdf2$')) {
      if (await pbkdf2Verify(oldToken, r.token_hash)) { matched = r; break; }
    } else {
      if (r.token_hash === await sha256Hex(oldToken)) { matched = r; break; }
    }
  }
  if (!matched) return null;

  // Mint new key (PBKDF2): revoke old, blacklist old hash, insert new row.
  const newKey = genApiKey();
  const newHash = await pbkdf2Hash(newKey);
  const newId = 'admin_' + nanoid(12);
  const oldHashSha = await sha256Hex(oldToken);
  const now = nowMs();
  await env.DB.batch([
    env.DB.prepare(`UPDATE admin_tokens SET revoked_at=? WHERE id=?`).bind(now, matched.id),
    env.DB.prepare(
      `INSERT INTO admin_tokens (id, token_hash, label, created_at) VALUES (?,?,?,?)`
    ).bind(newId, newHash, 'rotated', now),
  ]);
  await env.KV.put(`revoked_admin:${oldHashSha}`, '1'); // fast 403 for stale callers
  return { key: newKey, id: newId };
}

// ── IP rate limiting (per-window counter in KV) ───────────────────────
// 5 attempts per 5 minutes per source IP. Sliding-ish via KV TTL.
const RL_WINDOW_SEC = 300;
const RL_MAX = 5;

/** Returns null if allowed, else {Response error}. */
export async function ipRateLimit(env: Bindings, req: Request, ns: string): Promise<Response | null> {
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'anon';
  const key = `rl:${ns}:${ip}`;
  const cur = parseInt((await env.KV.get(key)) ?? '0', 10);
  if (cur >= RL_MAX) {
    return err(429, 'too many attempts, try again later', { window_sec: RL_WINDOW_SEC, retry_after_sec: RL_WINDOW_SEC });
  }
  await env.KV.put(key, String(cur + 1), { expirationTtl: RL_WINDOW_SEC });
  return null;
}