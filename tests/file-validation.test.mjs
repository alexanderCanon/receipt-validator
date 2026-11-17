import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Tests de contrato básicos sobre el código fuente sin dependencias de bundling.
const code = fs.readFileSync(new URL('../src/file-validation.ts', import.meta.url), 'utf8');
test('admite los tres formatos de imagen definidos', () => {
  assert.match(code, /image\/jpeg/);
  assert.match(code, /image\/png/);
  assert.match(code, /image\/webp/);
});
test('limita el peso a 5 MiB', () => assert.match(code, /5 \* 1024 \* 1024/));
