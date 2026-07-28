import type { Bindings, Human } from './types';
import { genSessionToken, nanoid, nowMs, pbkdf2Hash, pbkdf2Verify, sha256Hex } from './utils';

export const SESSION_COOKIE = 'aw_session';
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export async function createHuman(
  env: Bindings,
  input: { email: string; displayName: string; password: string },
): Promise<{ human: Human; token: string }> {
  const email = input.email.trim().toLowerCase();
  const id = `human_${nanoid(16)}`;
  const ts = nowMs();
  const passwordHash = await pbkdf2Hash(input.password);
  await env.DB.prepare(
    `INSERT INTO humans
       (id, email, display_name, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).bind(id, email, input.displayName.trim().slice(0, 80), passwordHash, ts, ts).run();
  const token = await createSession(env, id);
  return {
    human: { id, email, display_name: input.displayName.trim().slice(0, 80), status: 'active', created_at: ts },
    token,
  };
}

export async function loginHuman(
  env: Bindings,
  emailInput: string,
  password: string,
): Promise<{ human: Human; token: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, display_name, password_hash, status, created_at
       FROM humans WHERE email=? LIMIT 1`,
  ).bind(emailInput.trim().toLowerCase()).first<Human & { password_hash: string }>();
  if (!row || row.status !== 'active' || !await pbkdf2Verify(password, row.password_hash)) return null;
  const token = await createSession(env, row.id);
  return {
    human: {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      status: row.status,
      created_at: row.created_at,
    },
    token,
  };
}

export async function resolveHuman(env: Bindings, request: Request): Promise<Human | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token?.startsWith('aws_')) return null;
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    `SELECT h.id, h.email, h.display_name, h.status, h.created_at
       FROM human_sessions s
       JOIN humans h ON h.id=s.human_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?
        AND h.status='active'
      LIMIT 1`,
  ).bind(tokenHash, nowMs()).first<Human>();
}

export async function revokeHumanSession(env: Bindings, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await env.DB.prepare(
    `UPDATE human_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL`,
  ).bind(nowMs(), await sha256Hex(token)).run();
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return Boolean(origin && origin === new URL(request.url).origin);
}

async function createSession(env: Bindings, humanId: string): Promise<string> {
  const token = genSessionToken();
  const ts = nowMs();
  await env.DB.prepare(
    `INSERT INTO human_sessions
       (id, human_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(`session_${nanoid(16)}`, humanId, await sha256Hex(token), ts, ts + SESSION_MAX_AGE_SEC * 1000).run();
  return token;
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
