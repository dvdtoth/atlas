import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readNode,
  surface,
  foldAt,
  basis,
  look,
  add,
  mul,
  norm,
  sub,
  dot,
} from '../src/render/core.mjs';
const visibility = await import('../src/render/visibility.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

function sceneOf(records) {
  const view = new DataView(new ArrayBuffer(records.length * 96));
  const first = new Int32Array(records.length).fill(-1),
    next = new Int32Array(records.length).fill(-1);
  const elevations = new Float64Array(records.length),
    bases = new Float64Array(records.length),
    tops = new Float64Array(records.length);
  records.forEach((record, i) => {
    const n = {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      id: i + 1,
      parent: 0xffffffff,
      lines: 10,
      columns: 20,
      panels: 1,
      depth: 0,
      kind: 1,
      ...record,
    };
    const p = i * 96;
    [n.x, n.y, n.w, n.h].forEach((v, j) => view.setFloat64(p + j * 8, v, true));
    [
      n.id,
      n.parent,
      n.lines,
      n.columns,
      n.panels,
      n.depth,
      n.kind,
      0,
      n.displayLines ?? n.lines,
      n.displayColumns ?? n.columns,
      0,
      0,
      0,
      0,
      0,
      0,
    ].forEach((v, j) => view.setUint32(p + 32 + j * 4, v, true));
    if (n.parent !== 0xffffffff) {
      next[i] = first[n.parent];
      first[n.parent] = i;
    }
    elevations[i] = n.elevation || 0;
    if (n.kind) {
      const s = surface(n),
        chunk = Math.max(96, Math.ceil(n.lines / 2048));
      bases[i] = elevations[i] + 3 * s.lineHeight;
      tops[i] = bases[i] + Math.min(chunk, s.rows) * s.lineHeight * Math.sqrt(1 - 0.34 ** 2);
    } else {
      bases[i] = Infinity;
      tops[i] = -Infinity;
    }
  });
  for (let i = records.length - 1; i >= 0; i--) {
    const n = readNode(view, i);
    if (n.parent !== 0xffffffff) {
      bases[n.parent] = Math.min(bases[n.parent], bases[i]);
      tops[n.parent] = Math.max(tops[n.parent], tops[i]);
    }
  }
  return { view, count: records.length, first, next, elevations, bases, tops };
}

test('2D collection reads display rows and prunes branches outside the viewport', () => {
  assert.equal(typeof visibility.collect2D, 'function');
  const scene = sceneOf([
    { kind: 0, w: 200, h: 100 },
    { parent: 0, kind: 0, w: 100, h: 100, depth: 1 },
    { parent: 1, w: 100, h: 100, depth: 2, lines: 10, displayLines: 20 },
    { parent: 0, kind: 0, x: 100, w: 100, h: 100, depth: 1 },
    { parent: 3, x: 100, w: 100, h: 100, depth: 2 },
  ]);
  const result = visibility.collect2D(scene, { x: 50, y: 50, scale: 2 }, 180, 180);
  assert.deepEqual(
    result.files.map((n) => n.index),
    [2],
  );
  assert.equal(result.files[0].lines, 20);
  assert.equal(result.files[0].display, true);
  assert.ok(result.files[0].projectedLineHeight > 1);
  assert.ok(!result.folders.some((n) => n.index === 3));
});

test('2D picking follows hierarchy and assigns a shared edge to exactly one document', () => {
  assert.equal(typeof visibility.pick2D, 'function');
  const scene = sceneOf([
    { kind: 0, w: 200 },
    { parent: 0, w: 100 },
    { parent: 0, x: 100, w: 100 },
  ]);
  assert.equal(visibility.pick2D(scene, 99.999, 50).index, 1);
  assert.equal(visibility.pick2D(scene, 100, 50).index, 2);
  assert.equal(visibility.pick2D(scene, 200, 50), null);
  assert.equal(visibility.pick2D(scene, -1, 50), null);
});

test('visibility work and returned file candidates stay bounded in a flat dense scene', () => {
  assert.equal(typeof visibility.collect2D, 'function');
  const records = [{ kind: 0, w: 20000, h: 100 }];
  for (let i = 0; i < 20000; i++)
    records.push({ parent: 0, x: i, w: 1, h: 100, lines: 1, columns: 1 });
  const result = visibility.collect2D(
    sceneOf(records),
    { x: 10000, y: 50, scale: 10 },
    200000,
    1000,
  );
  assert.ok(result.visited <= 16000);
  assert.ok(result.files.length <= 96);
  assert.equal(result.truncated, true);
});

test('orientation preserves the geometric sheet and makes source advance right and down', () => {
  assert.equal(typeof visibility.orientFold, 'function');
  const f = {
    id: 8,
    node: 3,
    panel: 0,
    start: 32,
    count: 10,
    x: 1,
    y: 2,
    z: 3,
    w: 18,
    dy: 16,
    dz: 12,
    lineHeight: 2,
    columns: 20,
  };
  const cam = { right: [-1, 0, 0], up: [0, 1, 0] };
  const result = visibility.orientFold(f, cam);
  assert.deepEqual(result.origin, [19, 18, 15]);
  assert.deepEqual(result.across, [-18, 0, 0]);
  assert.deepEqual(result.down, [0, -16, -12]);
  assert.ok(dot(result.across, cam.right) >= 0);
  assert.ok(dot(result.down, cam.up) <= 0);
  assert.deepEqual(
    [result.x, result.y, result.z, result.w, result.dy, result.dz],
    [1, 2, 3, 18, 16, 12],
  );
  assert.deepEqual(visibility.orientFold(result, cam).origin, result.origin);
});

test('3D picking reports oriented source coordinates and selects the nearest sheet', () => {
  assert.equal(typeof visibility.pick3D, 'function');
  const f = {
    id: 8,
    node: 3,
    panel: 1,
    start: 32,
    count: 10,
    x: 1,
    y: 2,
    z: 3,
    w: 18,
    dy: 16,
    dz: 12,
    lineHeight: 2,
    columns: 20,
  };
  const oriented = visibility.orientFold(f, { right: [-1, 0, 0], up: [0, 1, 0] });
  const target = add(add(oriented.origin, mul(oriented.across, 0.25)), mul(oriented.down, 0.35));
  const eye = add(target, [0, 30, -40]),
    ray = norm(sub(target, eye));
  const far = { ...oriented, origin: add(oriented.origin, mul(ray, 40)) };
  const hit = visibility.pick3D([far, oriented], eye, ray);
  assert.equal(hit.node, 3);
  assert.equal(hit.line, 35);
  assert.equal(hit.column, 5);
  assert.ok(Math.abs(hit.distance - 50) < 1e-8);
  assert.equal(visibility.pick3D([oriented], eye, mul(ray, -1)), null);
});

test('3D traversal retains elevated child folds and rejects a file behind the camera', () => {
  assert.equal(typeof visibility.collect3D, 'function');
  const scene = sceneOf([
    { kind: 0, x: 0, y: -1000, w: 100, h: 1100 },
    { parent: 0, x: 0, y: 0, w: 100, h: 100, elevation: 5000 },
    { parent: 0, x: 0, y: -1000, w: 100, h: 100, elevation: 5000 },
  ]);
  const file = readNode(scene.view, 1),
    f = foldAt(file, 0, 5000);
  const target = [f.x + f.w / 2, f.y + f.dy / 2, f.z + f.dz / 2];
  const eye = add(target, [0, 0, -100]),
    cam = { eye, ...look(eye, target) };
  const result = visibility.collect3D(scene, cam, 1000, 800);
  assert.ok(result.folds.some((fold) => fold.node === 1));
  assert.ok(!result.folds.some((fold) => fold.node === 2));
  assert.ok(result.folds.every((fold) => fold.origin && fold.across && fold.down));
  assert.ok(result.folds.length <= 4000);
});

test('a folded sheet crossing the camera plane remains a conservative visible candidate', () => {
  assert.equal(typeof visibility.collect3D, 'function');
  const scene = sceneOf([{ lines: 96, w: 200, h: 800, columns: 40 }]);
  const n = readNode(scene.view, 0),
    f = foldAt(n, 0);
  const eye = [f.x + f.w / 2, f.y + f.dy / 2 + 2, f.z + f.dz / 2];
  const target = [f.x + f.w / 2, f.y + f.dy * 0.75, f.z + f.dz * 0.75];
  const result = visibility.collect3D(scene, { eye, ...look(eye, target) }, 1000, 800);
  assert.ok(result.folds.length > 0);
});

test('3D traversal does not decode descendants whose whole folder projects below one pixel', () => {
  const scene = sceneOf([
    { kind: 0, w: 100000, h: 100000 },
    { parent: 0, kind: 0, x: 50000, y: 50000, w: 0.1, h: 0.1 },
    { parent: 1, x: 50000, y: 50000, w: 0.1, h: 0.1 },
  ]);
  const target = [50000, 0, 17000],
    eye = [50000, 100000, 17000];
  const result = visibility.collect3D(scene, { eye, ...look(eye, target) }, 1400, 900);
  assert.equal(result.visited, 2);
  assert.deepEqual(result.files, []);
});

test('3D text candidates can expand on capable browsers and remain bounded on small ones', () => {
  const records = [{ kind: 0, w: 1600, h: 1000 }];
  for (let i = 0; i < 400; i++)
    records.push({
      parent: 0,
      x: (i % 20) * 80,
      y: Math.floor(i / 20) * 50,
      w: 78,
      h: 48,
      lines: 1,
      columns: 5,
    });
  const scene = sceneOf(records),
    eye = [800, 1000, 170],
    cam = { eye, ...look(eye, [800, 0, 170]) };
  const small = visibility.collect3D(scene, cam, 1600, 1000, 2, { maxFiles: 64 });
  const large = visibility.collect3D(scene, cam, 1600, 1000, 2, { maxFiles: 640 });
  assert.ok(small.files.length <= 64);
  assert.ok(large.files.length > 192);
  assert.ok(large.files.length <= 640);
});

test('2D collection keeps subpixel source rows eligible for coloured minimap tiles', () => {
  const scene = sceneOf([{ lines: 100, h: 104, w: 100 }]);
  const result = visibility.collect2D(scene, { x: 50, y: 52, scale: 0.8 }, 180, 180);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].projectedLineHeight, 0.8);
});
