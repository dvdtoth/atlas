import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDocument, sourceSelection, sourceAddress } from '../src/index/client-index.mjs';
import { selectionPlanes2D, selectionPlanes3D } from '../src/render/source-selection.mjs';
import { surface, sourceAt, add, mul, basis } from '../src/render/core.mjs';
import { orientFold, pick3D } from '../src/render/visibility.mjs';
import { sourceFlightPose } from '../src/render/flight-navigation.mjs';

const doc = (text) => analyzeDocument({ id: 7, path: 'test.js', revision: 'r', text });
const center = (p) => add(add(p.origin, mul(p.across, 0.5)), mul(p.down, 0.5));
test('selected symbol carries exact source and wrapped display endpoints', () => {
  const d = doc('short\n'.repeat(9) + 'x'.repeat(158) + 'symbol' + 'x'.repeat(200) + '\nlast');
  const selected = sourceSelection(d, { line: 9, column: 158, endLine: 9, endColumn: 164 });
  assert.deepEqual(selected.source, {
    start: { line: 9, column: 158 },
    end: { line: 9, column: 164 },
  });
  assert.deepEqual(selected.display, {
    start: { line: 10, column: 78 },
    end: { line: 11, column: 4 },
  });
  assert.equal(
    selected.address.displayLine,
    sourceAddress(d, { line: 9, column: 158 }).displayLine,
  );
  const n = {
    id: 7,
    x: 10,
    y: 20,
    w: 300,
    h: 500,
    lines: d.displayLines,
    columns: d.displayColumns,
    panels: 3,
  };
  const planes = selectionPlanes2D(n, selected.display);
  assert.equal(planes.length, 2);
  for (const [i, p] of planes.entries()) {
    const [x, y] = center(p),
      hit = sourceAt(n, x, y);
    assert.equal(hit.line, 10 + i);
  }
  const h = surface(n).lineHeight;
  assert.ok(Math.abs(planes[0].across[0] / (0.45 * h) - 2) < 1e-8);
  assert.ok(Math.abs(planes[1].across[0] / (0.45 * h) - 4) < 1e-8);
});

test('line-only selections cover wrapped continuations, and EOF endpoints remain half-open', () => {
  const d = doc('short\n'.repeat(9) + 'x'.repeat(160) + '\n');
  const selected = sourceSelection(d, { line: 9, column: 120 });
  assert.deepEqual(selected.display, {
    start: { line: 9, column: 0 },
    end: { line: 11, column: 0 },
  });
  assert.deepEqual(
    sourceSelection(d, { line: 9, column: 158, endLine: 10, endColumn: 0 }).display.end,
    { line: 11, column: 0 },
  );
  assert.throws(
    () => sourceSelection(d, { line: 9, column: 0, endLine: 11, endColumn: 0 }),
    /line/,
  );
  assert.throws(
    () => sourceSelection(d, { line: 9, column: 5, endLine: 8, endColumn: 1 }),
    /range/,
  );
  const n = { id: 7, x: 0, y: 0, w: 200, h: 300, lines: 12, columns: 80, panels: 1 };
  assert.equal(
    selectionPlanes2D(n, { start: { line: 9, column: 78 }, end: { line: 10, column: 0 } }).length,
    1,
  );
});

test('3D highlight geometry follows displayed fold orientation and stays on the selected rows', () => {
  const n = { id: 7, index: 1, x: 2e5, y: 3e5, w: 220, h: 600, lines: 401, columns: 90, panels: 1 };
  for (const line of [0, 95, 96, 191, 300, 400]) {
    const pose = sourceFlightPose(n, line, 20, 10),
      fold = orientFold(pose.fold, pose);
    const planes = selectionPlanes3D(
      n,
      { start: { line, column: 20 }, end: { line, column: 26 } },
      [fold],
    );
    assert.equal(planes.length, 1);
    const p = center(planes[0]),
      ray = basis(pose.yaw, pose.pitch).forward;
    const hit = pick3D([fold], add(p, mul(ray, -10)), ray);
    assert.equal(hit.line, line);
    assert.ok(Math.abs(hit.column - 23) <= 1);
  }
});

test('range planes split at panel boundaries with bounded work and no bleed into neighbouring files', () => {
  const n = { id: 7, x: 1e8, y: 2e8, w: 1000, h: 500, lines: 1000000, columns: 80, panels: 32 };
  const planes = selectionPlanes2D(n, {
    start: { line: 0, column: 2 },
    end: { line: 999999, column: 5 },
  });
  assert.ok(planes.length <= 34);
  for (const p of planes) {
    assert.ok(p.origin[0] >= n.x && p.origin[1] >= n.y);
    assert.ok(p.origin[0] + p.across[0] <= n.x + n.w);
    assert.ok(p.origin[1] + p.down[1] <= n.y + n.h);
  }
});
