import test from 'node:test';
import assert from 'node:assert/strict';
import { vectorLiteral } from './database';

test('formats finite embedding values for a parameterized pgvector query', () => {
  assert.equal(vectorLiteral([0.25, -0.5, 1]), '[0.25,-0.5,1]');
  assert.throws(() => vectorLiteral([]), /finite numeric values/);
  assert.throws(() => vectorLiteral([Number.NaN]), /finite numeric values/);
});
