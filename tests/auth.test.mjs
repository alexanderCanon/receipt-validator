import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin, expiredCookie } from '../src/auth.ts';

test('bloquea solicitudes sin Origin y desde un origen distinto', () => {
  assert.equal(sameOrigin(new Request('https://example.com/api/receipts')), false);
  assert.equal(sameOrigin(new Request('https://example.com/api/receipts', {
    headers: { Origin: 'https://evil.example.com' },
  })), false);
  assert.equal(sameOrigin(new Request('https://example.com/api/receipts', {
    headers: { Origin: 'https://example.com' },
  })), true);
});
test('la cookie de cierre mantiene propiedades de seguridad', () => {
  assert.match(expiredCookie(), /HttpOnly; Secure; SameSite=Strict/);
});
