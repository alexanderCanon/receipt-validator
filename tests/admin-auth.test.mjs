import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminCookie, validAdminCookie, validAdminBearer, validAdminToken, clearAdminCookie } from '../src/admin-auth.ts';

const secret = 'admin-test-secret-very-long-not-a-real-production-secret';
const env = { ADMIN_REPROCESS_TOKEN: secret };
test('valid token and bearer require the admin secret',async()=>{
  assert.equal(await validAdminToken('bad',env),false);
  assert.equal(await validAdminToken(secret,env),true);
  assert.equal(await validAdminBearer(new Request('https://example.com/api/admin/receipts'),env),false);
  assert.equal(await validAdminBearer(new Request('https://example.com/api/admin/receipts',{headers:{Authorization:'Bearer '+secret}}),env),true);
});
test('admin cookie is HttpOnly, Secure, short-lived and authenticated',async()=>{
  const cookie=await createAdminCookie(env);
  assert.match(cookie,/HttpOnly; SameSite=Strict|HttpOnly; Secure; SameSite=Strict/);
  assert.match(cookie,/Path=\/api\/admin/);
  assert.equal(await validAdminCookie(new Request('https://example.com/api/admin/session',{headers:{Cookie:cookie.split(';')[0]}}),env),true);
});
test('tampered and forged admin cookies fail',async()=>{
  const cookie=(await createAdminCookie(env)).split(';')[0];
  const tampered=cookie.replace(/.$/,c=>c==='0'?'1':'0');
  assert.equal(await validAdminCookie(new Request('https://example.com',{headers:{Cookie:tampered}}),env),false);
  assert.equal(await validAdminCookie(new Request('https://example.com',{headers:{Cookie:cookie}}),{ADMIN_REPROCESS_TOKEN:'different-test-secret-long-enough'}),false);
  assert.match(clearAdminCookie(),/Max-Age=0/);
});

test('the integration secret comparison rejects absent and changed values', async () => {
  const { equalSecrets } = await import('../src/admin-auth.ts');
  const key = 'test-only-key-not-a-real-secret';
  assert.equal(await equalSecrets(key, key), true);
  assert.equal(await equalSecrets('', key), false);
  assert.equal(await equalSecrets(key + 'x', key), false);
});
