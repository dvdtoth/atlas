import test from 'node:test';
import assert from 'node:assert/strict';
import { surface, foldAt, sourceAt, travel, DEPTH, RISE } from '../src/render/core.mjs';
const n = { x: 98765.123, y: 2048, w: 500, h: 800, lines: 203, columns: 80, panels: 3 };
test('ordered columns cover every source row and preserve readable dimensions', () => {
  const s = surface(n);
  assert.ok(s);
  const ranges = Array.from({ length: 3 }, (_, p) => s.panel(p));
  assert.deepEqual(
    ranges.map((p) => [p.start, p.count]),
    [
      [0, 68],
      [68, 68],
      [136, 67],
    ],
  );
  const p = ranges[1],
    at = sourceAt(n, p.x + s.lineHeight * 9 * 0.45, p.y + s.lineHeight * 12.5);
  assert.equal(at.line, 80);
  assert.equal(at.column, 9);
});
test('folded source retains exact line length and contiguous source coordinates', () => {
  const raw = { ...n, lines: 401, panels: 1 };
  const s = surface(raw);
  for (const line of [0, 95, 96, 191, 192, 400]) {
    const f = foldAt(raw, line, 10);
    assert.ok(f);
    assert.ok(f.start <= line && f.start + f.count > line);
    assert.ok(Math.abs(Math.hypot(f.dy, f.dz) / f.count - s.lineHeight) < 1e-9);
    assert.equal(f.z, (s.panel(0).y + f.start * s.lineHeight) * DEPTH);
  }
});
test('search trip has exact endpoints, concurrent pan and zoom and finite deep zoom', () => {
  const a = { x: 0, y: 0, scale: 0.01 },
    b = { x: 50000.12, y: 13000, scale: 300000 };
  assert.deepEqual(travel(a, b, 0, 1000), a);
  assert.deepEqual(travel(a, b, 1, 1000), b);
  assert.ok(travel(a, b, 0.25, 1000).x > 0 && travel(a, b, 0.25, 1000).x < b.x);
  for (let t = 0.01; t < 1; t += 0.01) {
    const c = travel(a, b, t, 1000);
    assert.ok(Number.isFinite(c.scale) && c.scale > 0);
    assert.ok(c.x >= a.x && c.x <= b.x);
  }
});
