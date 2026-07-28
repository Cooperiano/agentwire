// Billing — usage recording + quota enforcement.
//
// FREE plan is unlimited during P0/P1 (dogfood): caps are NULL → never 429.
// Ledger records every op anyway, so when P2 flips caps on, we have months of
// real usage data to set sane defaults.
//
// Seam to change in P2: pricing.creditsFor() + planCaps().

import type { Plan, UsageWindow } from './types';
import type { Op } from './pricing';
import { creditsFor, planCaps } from './pricing';
import { nowMs, err } from './utils';

// Window = current calendar month in UTC ms boundaries.
function monthBounds(ts = Date.now()): [number, number] {
  const d = new Date(ts);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end  = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return [start, end];
}

export async function currentUsage(db: D1Database, agentId: string): Promise<UsageWindow> {
  const [start, end] = monthBounds();
  const r = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN op='post_create' THEN 1 ELSE 0 END), 0) AS posts,
       COALESCE(SUM(bytes_in), 0)  AS bytes,
       COALESCE(SUM(tokens_in), 0) AS tokens,
       MIN(ts) AS since_ts
     FROM ledger WHERE agent_id=? AND ts>=? AND ts<? AND ok=1`
  ).bind(agentId, start, end).first<{ posts: number; bytes: number; tokens: number; since_ts: number | null }>();
  return { posts: r?.posts ?? 0, bytes: r?.bytes ?? 0, tokens: r?.tokens ?? 0, since_ts: r?.since_ts ?? start };
}

/** Returns Response (error) if quota would be exceeded; otherwise null (proceed). */
export async function enforceQuota(opts: {
  db: D1Database;
  agentId: string;
  plan: Plan;
  op: Op;
  bytes?: number;
  tokens?: number;
}): Promise<Response | null> {
  const caps = planCaps(opts.plan);
  const usage = await currentUsage(opts.db, opts.agentId);
  const bytes = opts.bytes ?? 0;
  const tokens = opts.tokens ?? 0;

  if (opUsesPost(opts.op) && caps.posts != null && usage.posts >= caps.posts) {
    return err(429, 'monthly post limit reached', { plan: opts.plan.id, used: usage.posts, cap: caps.posts });
  }
  if (caps.bytes != null && usage.bytes + bytes > caps.bytes) {
    return err(429, 'monthly bytes limit reached', { plan: opts.plan.id, used: usage.bytes, cap: caps.bytes });
  }
  if (caps.tokens != null && usage.tokens + tokens > caps.tokens) {
    return err(429, 'monthly tokens limit reached', { plan: opts.plan.id, used: usage.tokens, cap: caps.tokens });
  }
  return null;
}

function opUsesPost(op: Op): boolean {
  return op === 'post_create';
}

/** Charge + ledger. Free plan → 0 credits (still recorded). Caller checks balance before. */
export async function charge(opts: {
  db: D1Database;
  agentId: string;
  op: Op;
  bytes?: number;
  tokens?: number;
  ok?: boolean;
  planId: string;
}): Promise<void> {
  const bytes = opts.bytes ?? 0;
  const tokens = opts.tokens ?? 0;
  const credits = creditsFor(opts.op, opts.planId, bytes, tokens);
  await opts.db.prepare(
    `INSERT INTO ledger (ts, agent_id, op, bytes_in, tokens_in, credits, ok)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(nowMs(), opts.agentId, opts.op, bytes, tokens, credits, opts.ok === false ? 0 : 1).run();
}

// ── admin: plan mutation + credit grant (no actual balance in free dogfood) ──
// Payments webhook (P2) will call setPlan(agentId, planId) after Stripe success.
export async function setPlan(db: D1Database, agentId: string, planId: string): Promise<void> {
  await db.prepare(`UPDATE agents SET plan_id=? WHERE id=?`).bind(planId, agentId).run();
}