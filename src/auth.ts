import type { Bindings } from './types';

const COOKIE = 'receipt_session';
const TTL_SECONDS = 8 * 60 * 60;
const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}
function readCookie(request: Request): string | null {
  const value = request.headers.get('Cookie')?.split(';').map(x => x.trim())
    .find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function expiredCookie(): string {
  return `${COOKIE}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`;
}
export async function sessionActive(request: Request, db: D1Database): Promise<boolean> {
  const token = readCookie(request);
  if (!token) return false;
  const result = await db.prepare('SELECT 1 AS valid FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(await digest(token), Math.floor(Date.now() / 1000)).first();
  return !!result;
}
export async function logout(request: Request, db: D1Database): Promise<void> {
  const token = readCookie(request);
  if (token) await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
    .bind(await digest(token)).run();
}

export type LoginResult = { ok: true; cookie: string } | { ok: false; status: 400 | 401 | 429 | 503 };
export async function login(pin: unknown, ip: string, env: Bindings): Promise<LoginResult> {
  if (!env.ACCESS_PIN || !/^\d{6}$/.test(env.ACCESS_PIN) ||
      !env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) {
    return { ok: false, status: 503 };
  }
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return { ok: false, status: 400 };
  const ipHash = await hmac(env.AUTH_PEPPER, ip);
  const now = Math.floor(Date.now() / 1000);
  // Atomic claim per IP and 15-minute window: cap concurrent brute-force attempts too.
  await env.DB.prepare(`INSERT INTO auth_attempts (ip_hash, window_started, failed_count)
    VALUES (?, ?, 0) ON CONFLICT(ip_hash) DO UPDATE SET
    failed_count = CASE WHEN window_started <= ? THEN 0 ELSE failed_count END,
    window_started = CASE WHEN window_started <= ? THEN excluded.window_started ELSE window_started END`)
    .bind(ipHash, now, now - WINDOW_SECONDS, now - WINDOW_SECONDS).run();
  const updated = await env.DB.prepare(`UPDATE auth_attempts SET failed_count = failed_count + 1
    WHERE ip_hash = ? AND failed_count < ? RETURNING failed_count`)
    .bind(ipHash, MAX_FAILURES).first();
  if (!updated) return { ok: false, status: 429 };

  const provided = await hmac(env.AUTH_PEPPER, pin);
  const expected = await hmac(env.AUTH_PEPPER, env.ACCESS_PIN);
  if (!equalHex(provided, expected)) return { ok: false, status: 401 };

  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_attempts WHERE ip_hash = ?').bind(ipHash),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
      .bind(await digest(token), now + TTL_SECONDS, now)
  ]);
  return { ok: true, cookie: sessionCookie(token) };
}
