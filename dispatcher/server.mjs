// Dispatcher + billing — scoped, multi-tenant, credit-metered HTTP front-end for the OpenClaw service.
// Calls the OpenClaw gateway inside the same container via loopback trust.
// This is the ONLY port FRP/Tunnel should expose — never expose the raw gateway (18789) publicly.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const execFileP = promisify(execFile);

// ── config ──────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.DISPATCHER_PORT || '8080', 10);
const TIMEOUT_MS = parseInt(process.env.AGENT_TIMEOUT_MS || '180000', 10);
const MAX_BUFFER = 20 * 1024 * 1024;
const STORE_PATH = process.env.BILLING_STORE || `${process.env.HOME}/.openclaw/billing.json`;

// credit cost per endpoint (1 credit ≈ ¥0.01 — adjust to taste)
const PRICES = {
  '/v1/scan-zhihu':  10,
  '/v1/write-zhihu': 2,
};

// ── billing store (single-process, file-persisted JSON) ─────────────────
function loadStore() {
  let s, fresh = false;
  try { s = JSON.parse(readFileSync(STORE_PATH, 'utf8')); }
  catch { s = {}; fresh = true; mkdirSync(dirname(STORE_PATH), { recursive: true }); }
  // migration-safe defaults — old stores may lack newer fields
  s.admin_key      = s.admin_key      || genKey();
  s.customers      = s.customers      || [];
  s.ledger         = s.ledger         || [];
  s.orders         = s.orders         || [];
  s.usdc_last_block = s.usdc_last_block || 0;
  s.deposit_config = {
    cny_per_credit: 0.01, wechat: '', alipay: '',
    usdc_address: '0xCCDb0C11603f17e9e99a1698dd3eFD50dF22161c',
    usdc_per_credit: 0.0014,
    ...s.deposit_config,
  };
  saveStore(s);
  if (fresh) {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  ADMIN KEY — create customers / grant credits             ║');
    console.log(`║  ${s.admin_key}`);
    console.log('║  Header: X-Admin-Key on /admin/*                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
  }
  return s;
}
function saveStore(s) { writeFileSync(STORE_PATH, JSON.stringify(s, null, 2)); }
function genKey() { return (randomUUID() + randomUUID()).replace(/-/g, ''); }

const store = loadStore();
const findCustomerByKey = (k) => store.customers.find(c => c.key === k);
const findCustomerById  = (id) => store.customers.find(c => c.id === id);

/** Record a ledger entry (and persist). Deduction of `credits` is the caller's job. */
function record(customerId, endpoint, credits, ok, extra) {
  store.ledger.push({ ts: Date.now(), customer_id: customerId, endpoint, credits, ok, ...extra });
  if (store.ledger.length > 10000) store.ledger = store.ledger.slice(-10000);
  saveStore(store);
}

// ── rate limiter (per-key, 20 req / 60 s) ──────────────────────────────
const buckets = new Map();
function rateLimit(key) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) b = { count: 0, reset: now + 60_000 };
  b.count++; buckets.set(key, b);
  return b.count <= 20 ? null : Math.ceil((b.reset - now) / 1000);
}

// ── helpers ─────────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
  });
}
function extractAnswer(output) {
  const walk = (v) => {
    if (!v || typeof v !== 'object') return null;
    if (v.finalAssistantVisibleText) return v.finalAssistantVisibleText;
    for (const c of Object.values(v)) { const r = walk(c); if (r) return r; }
    return null;
  };
  return walk(output) ?? '(no answer in agent output)';
}
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cand = fenced ? fenced[1] : text;
  const start = cand.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cand.length; i++) {
    const c = cand[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(cand.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
async function runAgent(agentId, model, message) {
  const sessionKey = `api-${randomUUID().slice(0, 8)}`;
  const args = ['agent', '--agent', agentId, '--session-key', sessionKey,
                '--model', model, '--message', message, '--json',
                '--timeout', String(Math.floor(TIMEOUT_MS / 1000))];
  const { stdout } = await execFileP('openclaw', args, { timeout: TIMEOUT_MS + 30_000, maxBuffer: MAX_BUFFER });
  return JSON.parse(stdout);
}

// ── USDC watcher (Base) — auto-fulfill deposit orders matching incoming USDC ─
const BASE_RPC       = process.env.BASE_RPC || 'https://mainnet.base.org';
const USDC_BASE      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base native USDC (6 decimals)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const padAddr = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

async function rpc(method, params) {
  const r = await fetch(BASE_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function usdcWatcherTick() {
  const cfg = store.deposit_config;
  if (!cfg.usdc_address) return;
  try {
    const latest = parseInt(await rpc('eth_blockNumber', []), 16);
    if (!store.usdc_last_block) { store.usdc_last_block = latest; saveStore(store); return; } // first run: anchor at tip
    if (latest <= store.usdc_last_block) return;
    const from = store.usdc_last_block + 1;
    const to = Math.min(latest, store.usdc_last_block + 5000);
    const logs = await rpc('eth_getLogs', [{ address: USDC_BASE, topics: [TRANSFER_TOPIC, null, padAddr(cfg.usdc_address)],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    for (const log of logs) {
      const micro = parseInt(log.data.slice(0, 66), 16); // value word (USDC has 6 decimals)
      const order = store.orders.find(o => o.status === 'pending' && o.amount_usdc_micro === micro);
      if (order) {
        const c = findCustomerById(order.customer_id);
        if (c) {
          c.balance += order.credits; order.status = 'fulfilled'; order.fulfilled_at = Date.now(); order.paid_via = 'usdc';
          saveStore(store);
          console.log(`[watcher] USDC in: fulfilled order ${order.id} (+${order.credits} credits, ${order.amount_usdc} USDC)`);
        }
      }
    }
    store.usdc_last_block = to; saveStore(store);
  } catch (e) { console.error('[watcher] poll error:', e.message); }
}

function startUsdcWatcher() {
  if (!store.deposit_config.usdc_address) { console.log('[watcher] disabled (no usdc_address)'); return; }
  console.log(`[watcher] watching USDC → ${store.deposit_config.usdc_address} on Base (rpc ${BASE_RPC})`);
  setInterval(usdcWatcherTick, 30000);
  usdcWatcherTick();
}

// ── http server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, X-Admin-Key, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { method, url } = req;

  // ---- public discovery (no auth) ----------------------------------------
  if (url === '/v1/health' && method === 'GET')
    return json(res, 200, { ok: true, ts: Date.now() });
  if (url === '/v1/pricing' && method === 'GET')
    return json(res, 200, { prices: PRICES, unit: '1 credit ≈ ¥0.01 (adjustable)', auth: 'X-API-Key (customer key) required for the above endpoints' });

  // ---- static files (QR images served without auth, path-traversal guarded) --
  if (url.startsWith('/qr/') && method === 'GET') {
    const file = url.split('/qr/')[1].replace(/\.\./g, '');
    try {
      const data = readFileSync(`${process.env.HOME}/.openclaw/qr/${file}`);
      const ext = file.split('.').pop().toLowerCase();
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    } catch { return json(res, 404, { error: 'not found' }); }
    return;
  }

  // ---- admin routes (X-Admin-Key) ----------------------------------------
  if (url.startsWith('/admin/')) {
    if (req.headers['x-admin-key'] !== store.admin_key)
      return json(res, 401, { error: 'invalid admin key' });

    if (url === '/admin/customers' && method === 'GET')
      return json(res, 200, { customers: store.customers.map(c => ({ id: c.id, name: c.name, balance: c.balance, created: c.created })) });

    if (url === '/admin/customers' && method === 'POST') {
      const b = await readBody(req);
      const init = Math.max(0, parseInt(b?.initial_credits || '0', 10));
      const c = { id: randomUUID().slice(0, 8), name: b?.name || 'unnamed', key: genKey(), balance: init, created: Date.now() };
      store.customers.push(c); saveStore(store);
      return json(res, 200, { ok: true, customer: { id: c.id, name: c.name, key: c.key, balance: c.balance } });
    }

    const creditMatch = url.match(/^\/admin\/customers\/([^/]+)\/credit$/);
    if (creditMatch && method === 'POST') {
      const c = findCustomerById(creditMatch[1]);
      if (!c) return json(res, 404, { error: 'customer not found' });
      const b = await readBody(req);
      const add = parseInt(b?.credits || '0', 10);
      c.balance += add; saveStore(store);
      return json(res, 200, { ok: true, customer: { id: c.id, name: c.name, balance: c.balance } });
    }

    if (url === '/admin/ledger' && method === 'GET')
      return json(res, 200, { entries: store.ledger.slice(-50) });

    if (url === '/admin/deposit-config' && method === 'GET')
      return json(res, 200, { deposit_config: store.deposit_config });
    if (url === '/admin/deposit-config' && method === 'POST') {
      const b = await readBody(req);
      store.deposit_config = { ...store.deposit_config, ...b };
      saveStore(store);
      return json(res, 200, { ok: true, deposit_config: store.deposit_config });
    }

    if (url.split('?')[0] === '/admin/orders' && method === 'GET') {
      const st = new URL('http://x' + req.url).searchParams.get('status');
      const list = store.orders.filter(o => !st || o.status === st).slice(-50).reverse();
      return json(res, 200, { orders: list });
    }
    const fulfillMatch = url.match(/^\/admin\/orders\/([^/]+)\/fulfill$/);
    if (fulfillMatch && method === 'POST') {
      const o = store.orders.find(o => o.id === fulfillMatch[1]);
      if (!o) return json(res, 404, { error: 'order not found' });
      if (o.status === 'fulfilled') return json(res, 409, { error: 'already fulfilled' });
      const c = findCustomerById(o.customer_id);
      if (!c) return json(res, 404, { error: 'customer vanished' });
      c.balance += o.credits; o.status = 'fulfilled'; o.fulfilled_at = Date.now();
      saveStore(store);
      return json(res, 200, { ok: true, order_id: o.id, customer: { name: c.name, balance: c.balance } });
    }

    return json(res, 404, { error: 'not found' });
  }

  // ---- customer (paid) routes (X-API-Key) --------------------------------
  const customer = findCustomerByKey(req.headers['x-api-key']);
  if (!customer) return json(res, 401, { error: 'invalid api key' });

  const rl = rateLimit(req.headers['x-api-key']);
  if (rl !== null) return json(res, 429, { error: 'rate limited', retryAfterSec: rl });

  // ---- deposit (manual WeChat/Alipay top-up) ----
  if (url === '/v1/deposit' && method === 'POST') {
    const body = await readBody(req);
    const credits = parseInt(body?.credits || '0', 10);
    if (credits <= 0) return json(res, 400, { error: 'credits (positive int) required' });
    const cfg = store.deposit_config;
    const amount = +(credits * cfg.cny_per_credit).toFixed(2);
    // USDC amount with a unique micro-suffix (on-chain matching — USDC has no memo field)
    let amountMicro = Math.round(credits * (cfg.usdc_per_credit || 0.0014) * 1e6);
    let suffix = Math.floor(Math.random() * 900) + 100;
    while (store.orders.some(o => o.status === 'pending' && o.amount_usdc_micro === amountMicro + suffix)) suffix = Math.floor(Math.random() * 900) + 100;
    amountMicro += suffix;
    const amountUsdc = (amountMicro / 1e6).toFixed(6);
    const order = { id: randomUUID().slice(0, 8), customer_id: customer.id, credits, amount_cny: amount,
                    amount_usdc: amountUsdc, amount_usdc_micro: amountMicro, status: 'pending', created: Date.now() };
    store.orders.push(order); saveStore(store);
    return json(res, 200, { order_id: order.id, credits, amount_cny: amount, status: 'pending',
      pay_to: { wechat: cfg.wechat, alipay: cfg.alipay, usdc: cfg.usdc_address ? { address: cfg.usdc_address, chain: 'base', amount_usdc: amountUsdc } : undefined },
      _debug: { usdc_addr: cfg.usdc_address, usdc_per_credit: cfg.usdc_per_credit },
      note: `微信/支付宝备注订单号 ${order.id}；USDC 请精确转 ${amountUsdc} 到 pay_to.usdc.address（金额含唯一零头，到账自动充值）` });
  }
  if (url.startsWith('/v1/deposit/') && method === 'GET') {
    const o = store.orders.find(o => o.id === url.split('/').pop() && o.customer_id === customer.id);
    if (!o) return json(res, 404, { error: 'order not found' });
    return json(res, 200, { order_id: o.id, credits: o.credits, amount_cny: o.amount_cny, status: o.status });
  }

  // balance pre-check (refuse before spending compute)
  const cost = PRICES[url];
  if (cost && customer.balance < cost)
    return json(res, 402, { error: 'insufficient credits', balance: customer.balance, cost });

  try {
    if (url === '/v1/scan-zhihu' && method === 'POST') {
      const body = await readBody(req);
      if (!body?.zhihu_url) return json(res, 400, { error: 'zhihu_url required' });
      const prompt = `用浏览器打开 ${body.zhihu_url}，扫描这个知乎账号，并以 JSON 格式返回（只输出 JSON）：{"nickname":"昵称","bio":"简介","followers_count":"粉丝数","following_count":"关注数","recent_articles":[{"title":"标题","url":"链接"}],"status":"正常/异常"}`;
      const result = await runAgent('main', 'deepseek/deepseek-v4-pro', prompt);
      const answer = extractAnswer(result);
      customer.balance -= cost; record(customer.id, url, cost, true);
      return json(res, 200, { ok: true, account: extractJson(answer) ?? answer, balance: customer.balance });
    }

    if (url === '/v1/write-zhihu' && method === 'POST') {
      const body = await readBody(req);
      if (!body?.topic) return json(res, 400, { error: 'topic required' });
      const parts = [`写一篇知乎文章，主题：${body.topic}。`];
      if (body.style)  parts.push(`风格：${body.style}。`);
      if (body.length) parts.push(`长度：${body.length}。`);
      parts.push('包括一个吸引人的标题。按知乎规范撰写。直接输出文章，不要多余说明。');
      const result = await runAgent('zhihu-writer', 'deepseek/deepseek-v4-pro', parts.join(' '));
      const answer = extractAnswer(result);
      customer.balance -= cost; record(customer.id, url, cost, true);
      return json(res, 200, { ok: true, answer, balance: customer.balance });
    }
  } catch (err) {
    console.error(`[${url}] agent error:`, err.message);
    record(customer.id, url, 0, false, { error: String(err.message).slice(0, 200) }); // no charge on failure, audit only
    return json(res, 500, { error: 'agent error', detail: String(err.message).slice(0, 300) });
  }

  json(res, 404, { error: 'not found' });
});

// ── lifecycle ───────────────────────────────────────────────────────────
server.on('error', (err) => { console.error('[dispatcher] server error:', err); process.exit(1); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
// never die on a single bad request — log and keep serving
process.on('uncaughtException',  (err) => console.error('[dispatcher] uncaught (survived):', err));
process.on('unhandledRejection', (err) => console.error('[dispatcher] unhandledRejection (survived):', err));
server.listen(PORT, '0.0.0.0', () => console.log(`[dispatcher] listening on :${PORT} (store: ${STORE_PATH})`));
startUsdcWatcher();
