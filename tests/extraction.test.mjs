import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction } from '../src/extraction.ts';
test('parsea salida JSON del modelo', () => {
  const result = parseExtraction({ response: '```json\n{"operationType":"CASH_DEPOSIT","bank":"Banco X","reference":"123","amount":50,"currency":"GTQ","transactionDate":"2026-11-17","suspectedTampering":false,"anomalies":[]}\n```' });
  assert.equal(result.operationType, 'CASH_DEPOSIT');
  assert.equal(result.reference, '123');
});
test('no inventa campos si vienen ausentes', () => {
  const result = parseExtraction({ response: '{}' });
  assert.equal(result.operationType, 'UNKNOWN');
  assert.equal(result.reference, null);
  assert.equal(result.amount, null);
});
test('falla de forma explícita con JSON inválido', () => {
  assert.throws(() => parseExtraction({ response: 'No puedo leer el documento' }));
});
