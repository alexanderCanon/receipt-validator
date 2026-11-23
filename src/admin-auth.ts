import type { Bindings } from './types';

const COOKIE = 'rv_admin';
const SESSION_SECONDS = 4 * 60 * 60;
function hex(bytes: Uint8Array): string {
  return [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}
async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}
export async function equalSecrets(a: string, b: string): Promise<boolean> {
  if (!a || !b || a.length > 512 || b.length > 512) return false;
  const [x,y] = await Promise.all([sha256(a),sha256(b)]);
  let difference = 0;
  for (let i=0;i<x.length;i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
export async function validAdminToken(value: string | null, env: Bindings): Promise<boolean> {
  return !!env.ADMIN_REPROCESS_TOKEN && env.ADMIN_REPROCESS_TOKEN.length >= 24 &&
    !!value && await equalSecrets(value, env.ADMIN_REPROCESS_TOKEN);
}
export async function validAdminBearer(req: Request, env: Bindings): Promise<boolean> {
  const header = req.headers.get('Authorization');
  return !!header?.startsWith('Bearer ') && await validAdminToken(header.slice(7), env);
}
export async function createAdminCookie(env: Bindings): Promise<string> {
  if (!env.ADMIN_REPROCESS_TOKEN || env.ADMIN_REPROCESS_TOKEN.length < 24) throw new Error('Admin token not configured');
  const expires = Math.floor(Date.now()/1000)+SESSION_SECONDS;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${expires}.${nonce}`;
  const signature = await sign(env.ADMIN_REPROCESS_TOKEN, payload);
  return `${COOKIE}=${payload}.${signature}; Path=/api/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}
export function clearAdminCookie(): string {
  return `${COOKIE}=; Path=/api/admin; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
export async function validAdminCookie(req: Request, env: Bindings): Promise<boolean> {
  if (!env.ADMIN_REPROCESS_TOKEN || env.ADMIN_REPROCESS_TOKEN.length < 24) return false;
  const entry = req.headers.get('Cookie')?.split(';').map(x=>x.trim())
    .find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
  if (!entry || entry.length > 200) return false;
  const parts = entry.split('.');
  if (parts.length !== 3) return false;
  const [expiry,nonce,signature] = parts;
  if (!/^\d{10,11}$/.test(expiry) || !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expires = Number(expiry), now = Math.floor(Date.now()/1000);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  const expected = await sign(env.ADMIN_REPROCESS_TOKEN, `${expiry}.${nonce}`);
  return equalSecrets(expected, signature);
}
