import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtraction, ExtractionFormatError } from '../src/extraction.ts';
import { decideReceipt } from '../src/validation.ts';

const sample = '{"operationType":"BANK_TRANSFER","bank":"Banco X","reference":"A123","amount":125,"currency":"GTQ","transactionDate":"2026-11-17","suspectedTampering":false,"anomalies":[]}';

test('acepta JSON precedido por texto natural', () => {
  assert.equal(parseExtraction({ response: 'Datos extraídos:\n' + sample }).reference, 'A123');
});
test('acepta JSON dentro de bloque markdown', () => {
  assert.equal(parseExtraction({ response: '```json\n' + sample + '\n```' }).amount, 125);
});
test('acepta objeto response desde JSON mode', () => {
  assert.equal(parseExtraction({ response: JSON.parse(sample) }).operationType, 'BANK_TRANSFER');
});
test('rechaza descripción sin JSON para activar normalización', () => {
  assert.throws(() => parseExtraction({ response: 'El comprobante es una transferencia.' }), ExtractionFormatError);
});
test('rechaza JSON sin clasificación explícita', () => {
  assert.throws(() => parseExtraction({ response: '{}' }), ExtractionFormatError);
});
test('no aprueba la normalización de salida libre', () => {
  const r = parseExtraction({ response: sample });
  r.anomalies.push('AI_OUTPUT_NORMALIZED_FROM_PROSE');
  assert.equal(decideReceipt(r, '2026-11-17').reason, 'AI_OUTPUT_UNVERIFIED');
});
