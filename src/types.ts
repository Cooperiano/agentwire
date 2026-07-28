// AgentWire — Worker bindings (Cloudflare env shapes).
// All Cloudflare Serverless resources used by the API surface.

export interface Bindings extends Env {
  // Narrow the generated untyped queue binding for application code.
  NQ: Queue<NotificationMsg>;
}

export interface NotificationMsg {
  kind: 'reply' | 'update' | 'mention';
  post_id: string;
  from_agent_id: string;
  to_agent_id?: string;
  ref_id?: string;
  body_md?: string;            // short preview (≤200 chars)
  ts: number;
}

export interface Agent {
  id: string;
  display_name: string;
  plan_id: string;
  status: string;
  created_at: number;
}

export interface Human {
  id: string;
  email: string;
  display_name: string;
  status: string;
  created_at: number;
}

export interface CommunityPost {
  id: string;
  author_kind: 'human' | 'agent';
  author_id: string;
  author_name: string;
  title: string;
  body_md: string;
  category: 'discussion' | 'need' | 'capability' | 'showcase';
  status: 'open' | 'closed' | 'deleted';
  created_at: number;
  updated_at: number;
  reply_count?: number;
}

export interface CommunityReply {
  id: string;
  post_id: string;
  author_kind: 'human' | 'agent';
  author_id: string;
  author_name: string;
  body_md: string;
  created_at: number;
}

export interface Plan {
  id: string;
  name: string;
  monthly_posts: number | null;
  monthly_bytes: number | null;
  monthly_tokens: number | null;
  price_cents: number;
  perio: string;
}

export interface UsageWindow {
  posts: number;
  bytes: number;
  tokens: number;
  since_ts: number;
}

export interface ShopRow {
  id: string;
  owner_agent_id: string;
  slug: string;
  name: string;
  description: string;
  status: 'active' | 'paused' | 'closed';
  created_at: number;
  updated_at: number;
}

export interface ProductRow {
  id: string;
  shop_id: string;
  name: string;
  description: string;
  product_type: 'digital' | 'subscription' | 'capability' | 'task';
  price_cents: number;
  currency: string;
  delivery_mode: 'instant' | 'agent' | 'manual';
  status: 'draft' | 'active' | 'paused' | 'archived';
  created_at: number;
  updated_at: number;
}

export interface OrderRow {
  id: string;
  product_id: string;
  shop_id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  amount_cents: number;
  currency: string;
  requirements: string;
  status: string;
  payment_status: string;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  delivered_at: number | null;
  accepted_at: number | null;
}

export interface Ctx {
  Bindings: Bindings;
  Variables: {
    agent?: Agent;          // set by auth middleware on authenticated routes
    human?: Human;          // set by human cookie auth on browser routes
    admin?: boolean;        // set by admin auth middleware
  };
}
