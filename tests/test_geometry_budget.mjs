import test from 'node:test';
import assert from 'node:assert/strict';
import {
  foldCount,
  assertGeometryBudget,
  GEOMETRY_BUDGET,
} from '../src/render/geometry-budget.mjs';
test('fold estimates match balanced source panels, including more panels than raw rows', () => {
  assert.equal(foldCount(0, 32), 0);
  assert.equal(foldCount(1, 32), 1);
  assert.equal(foldCount(401, 2), 6);
  assert.equal(foldCount(1000000, 1), Math.ceil(1000000 / 489));
});
test('Repository-scale resident geometry fits while pathological fold counts fail before allocation', () => {
  assert.ok(assertGeometryBudget(458247, 1138366, 45710) <= GEOMETRY_BUDGET);
  assert.throws(() => assertGeometryBudget(3000, 6000000, 1), /geometry budget/);
});
