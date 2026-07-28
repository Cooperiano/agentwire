// Tiny crypto helpers — all hashing uses WebCrypto (no deps).
// API keys are stored as SHA-256 hex; plaintext is shown exactly once at creation.
// Admin tokens are stored as PBKDF2(SHA-256, 100k iters) — slow-hash OK because
// admin auth is rare (operator only); agent auth stays on fast SHA-256.

const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256BytesHex(input: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

// PBKDF2 — used for admin_tokens stored hashes. Output format: pbkdf2$<iters>$<saltB64>$<hashB64url>
const PBKDF2_ITERS = 100_000;
export async function pbkdf2Hash(input: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(input), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: s, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    key, 256
  );
  const saltB64 = b64urlEncode(String.fromCharCode(...s));
  const hashB64 = b64urlEncode(String.fromCharCode(...new Uint8Array(bits)));
  return `pbkdf2$${PBKDF2_ITERS}$${saltB64}$${hashB64}`;
}
export async function pbkdf2Verify(input: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iters = parseInt(parts[1], 10);
  const salt = new Uint8Array([...b64urlDecode(parts[2])!].map(c => c.charCodeAt(0)));
  const key = await crypto.subtle.importKey('raw', enc.encode(input), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    key, 256
  );
  const got = b64urlEncode(String.fromCharCode(...new Uint8Array(bits)));
  return timingSafeEqual(got, parts[3]);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// base64url encode/decode — for opaque pagination cursors.
export function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): string | null {
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return null; }
}

// nanoid-ish — 21 chars from url-safe alphabet. Good enough for ids in D1.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export function nanoid(len = 21): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[buf[i] & 63];
  return out;
}

// API key format:  aw_<32 hex>. 3 chars longer than nanoid for巡查区分.
export function genApiKey(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
  return `aw_${hex}`;
}

export function genSessionToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return `aws_${b64urlEncode(String.fromCharCode(...buf))}`;
}

// Bearer / X-Api-Key parser. Returns null if absent.
export function extractApiKey(req: Request): string | null {
  const h = req.headers.get('X-Api-Key');
  if (h) return h.trim();
  const auth = req.headers.get('Authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

// Signed download URL: HMAC-SHA256(key, "id|exp") -> base64url. Stateless verify.
// Secret = JWT_SECRET (or ENV env secret). We carry sig in querystring `s`.
export async function signDownloadUrl(opts: {
  id: string;
  exp: number;                  // epoch ms
  secret: string;
  base: string;                 // e.g. https://agora.ledgendaryanimal.top
}): Promise<string> {
  const payload = `${opts.id}|${opts.exp}`;
  const sig = await hmacHex(opts.secret, payload);
  return `${opts.base}/v1/attachments/${opts.id}?exp=${opts.exp}&s=${sig}`;
}

export async function verifyDownloadUrl(opts: {
  id: string;
  exp: number;
  sig: string;
  secret: string;
}): Promise<boolean> {
  if (Date.now() > opts.exp) return false;
  const expected = await hmacHex(opts.secret, `${opts.id}|${opts.exp}`);
  return timingSafeEqual(expected, opts.sig);
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function nowMs(): number { return Date.now(); }

export function err(status: number, msg: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: msg, ...extra }, { status });
}

export function ok(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// Cheap token estimate: ~4 chars per token for mixed text. Good enough for ledger.
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
