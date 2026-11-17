import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideReceipt, normalizeClaim } from '../src/validation.ts';
const base = {
  operationType: 'BANK_TRANSFER', bank: 'Banco Industrial', reference: 'ABC-123',
  amount: 350, currency: 'GTQ', transactionDate: '2026-11-17',
  transactionTime: null, destinationAccount: null, suspectedTampering: false, anomalies: [],
};
test('aprueba operación permitida y reciente documentalmente', () => {
  assert.equal(decideReceipt(base, '2026-11-17').status, 'APPROVED');
});
test('rechaza cheques siempre', () => {
  assert.equal(decideReceipt({ ...base, operationType: 'CHECK_DEPOSIT' }, '2026-11-17').reason, 'CHECK_DEPOSIT');
});
test('acepta dos días y rechaza tres', () => {
  assert.equal(decideReceipt({ ...base, transactionDate: '2026-11-15' }, '2026-11-17').status, 'APPROVED');
  assert.equal(decideReceipt({ ...base, transactionDate: '2026-11-14' }, '2026-11-17').reason, 'EXPIRED_RECEIPT');
});
test('marca sospechas y fechas ilegibles para revisión', () => {
  assert.equal(decideReceipt({ ...base, suspectedTampering: true }, '2026-11-17').status, 'REVIEW_REQUIRED');
  assert.equal(decideReceipt({ ...base, transactionDate: '2026-02-30' }, '2026-11-17').reason, 'UNREADABLE_DATE');
});
test('normaliza referencia entre distintos formatos', () => {
  assert.equal(normalizeClaim(base), normalizeClaim({ ...base, reference: 'abc123', bank: 'BANCO INDUSTRIAL' }));
});
