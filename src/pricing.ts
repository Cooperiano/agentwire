// Pricing — the single switchboard for "how many credits does op cost on plan?".
// FREE plan charges 0 credits (admin/usage still recorded). Paid plans charge per op.
// This is the seam to edit when launching pricing in P2. Touch nothing else.

import type { Plan } from './types';

export type Op =
  | 'post_create'
  | 'update_add'
  | 'reply'
  | 'file_upload'
  | 'shop_create'
  | 'product_create'
  | 'order_create'
  | 'delivery_create'
  | 'order_accept'
  | 'login';

// cents-per-op on each paid plan. Edit here when pricing changes.
const TABLE: Record<string, Partial<Record<Op, number>>> = {
  free: {
    post_create: 0, update_add: 0, reply: 0, file_upload: 0, shop_create: 0,
    product_create: 0, order_create: 0, delivery_create: 0, order_accept: 0, login: 0,
  },
  pro: {
    post_create: 1, update_add: 0, reply: 0, file_upload: 1, shop_create: 1,
    product_create: 1, order_create: 0, delivery_create: 1, order_accept: 0, login: 0,
  },
  scale: {
    post_create: 2, update_add: 1, reply: 1, file_upload: 2, shop_create: 2,
    product_create: 1, order_create: 1, delivery_create: 1, order_accept: 0, login: 0,
  },
};

// Per-token and per-KB adders (paid plans). free = 0.
const TOKEN_RATE: Record<string, number> = { free: 0, pro: 0.001, scale: 0.0005 };   // credits / 1k tokens
const BYTE_RATE:  Record<string, number> = { free: 0, pro: 0.0001, scale: 0.00005 }; // credits / KB

/** Credits to charge for an op on a plan. Always integer (rounded up). */
export function creditsFor(op: Op, planId: string, bytes = 0, tokens = 0): number {
  const base = TABLE[planId]?.[op] ?? 0;
  const tok = (TOKEN_RATE[planId] ?? 0) * (tokens / 1000);
  const byt = (BYTE_RATE[planId]  ?? 0) * (bytes / 1024);
  return Math.ceil(base + tok + byt);
}

/** Monthly caps — NULL means unlimited (free during dogfood). */
export function planCaps(plan: Plan): { posts: number | null; bytes: number | null; tokens: number | null } {
  return { posts: plan.monthly_posts, bytes: plan.monthly_bytes, tokens: plan.monthly_tokens };
}

export const PLANS_SEED = [
  { id: 'free',  name: 'Free',  monthly_posts: null, monthly_bytes: null, monthly_tokens: null, price_cents: 0,    perio: 'forever' },
  { id: 'pro',   name: 'Pro',   monthly_posts: 1000, monthly_bytes: 1073741824, monthly_tokens: 2000000,  price_cents: 3000,  perio: 'month' },
  { id: 'scale', name: 'Scale', monthly_posts: null, monthly_bytes: 5368709120, monthly_tokens: 20000000, price_cents: 20000, perio: 'month' },
] as const;
