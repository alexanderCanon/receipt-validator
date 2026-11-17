import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccount, decideAccount } from '../src/accounts.ts';
const approved = { status: 'APPROVED', reason: 'DOCUMENT_CHECKS_PASSED' };
test('normaliza espacios y guiones sin cambiar dígitos', () => {
  assert.equal(normalizeAccount('1234-5678 9012'), '123456789012');
});
test('no acepta nombres, enmascarados ni cuentas parciales', () => {
  assert.equal(normalizeAccount('ANTONIO DAVID GORDILLO'), null);
  assert.equal(normalizeAccount('****1234'), null);
  assert.equal(normalizeAccount('1234'), null);
  assert.equal(normalizeAccount('123456...'), null);
});
test('la cuenta autorizada admite aprobación documental', () => {
  assert.deepEqual(decideAccount(approved, '123456789012', 2, true), approved);
});
test('sin cuenta completa se requiere revisión', () => {
  assert.equal(decideAccount(approved, null, 2, false).reason, 'DESTINATION_ACCOUNT_UNREADABLE');
});
test('una cuenta no autorizada se rechaza', () => {
  assert.equal(decideAccount(approved, '123456789012', 2, false).reason, 'DESTINATION_ACCOUNT_NOT_ALLOWED');
});
test('sin cuentas configuradas no se aprueba ni se rechaza por lista vacía', () => {
  assert.equal(decideAccount(approved, '123456789012', 0, false).reason, 'NO_ALLOWED_ACCOUNTS_CONFIGURED');
});
test('conserva rechazo previo por cheque y revisión por alteraciones', () => {
  assert.equal(decideAccount({status:'REJECTED',reason:'CHECK_DEPOSIT'},'123456789012',1,true).reason,'CHECK_DEPOSIT');
  assert.equal(decideAccount({status:'REVIEW_REQUIRED',reason:'POSSIBLE_TAMPERING'},'123456789012',1,true).reason,'POSSIBLE_TAMPERING');
});
