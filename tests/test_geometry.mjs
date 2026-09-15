import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readNode, foldAt, surface } from '../src/render/core.mjs';

test('worker GPU records agree with CPU folds and preserve deep-zoom coordinates', async () => {
  const nodes = new ArrayBuffer(3 * 96),
    v = new DataView(nodes);
  for (let i = 0; i < 3; i++) {
    const p = i * 96;
    [1e8 + 0.123 + i * 200, 2e8 + 0.456 + i * 20, i ? 180 : 1000, i ? 350 : 1000].forEach((x, j) =>
      v.setFloat64(p + j * 8, x, true),
    );
    for (const [off, value] of [
      [32, 100 + i],
      [36, i ? 0 : 0xffffffff],
      [40, i ? 401 : 0],
      [44, 90],
      [48, i ? 2 : 1],
      [52, i],
      [56, i ? 1 : 0],
      [60, 0xffbbaa55],
      [64, i ? 420 : 0],
      [68, 80],
      [72, i * 64],
      [76, i * 64 + 32],
    ])
      v.setUint32(p + off, value, true);
  }
  const original = nodes.slice(0),
    url = new URL('../src/render/geometry-worker.mjs', import.meta.url).href;
  const worker = new Worker(
    `import {parentPort} from 'node:worker_threads';globalThis.onmessage=null;globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);await import(${JSON.stringify(url)});parentPort.on('message',data=>onmessage({data}));`,
    { eval: true },
  );
  const result = await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (r) => {
      if (r.type === 'geometry') resolve(r);
      if (r.type === 'error') reject(Error(r.message));
    });
    worker.postMessage({ nodes }, [nodes]);
  });
  await worker.terminate();
  assert.equal(result.files, 2);
  assert.equal(result.folds, 12);
  assert.equal(result.map.byteLength, 192);
  assert.equal(result.flights[0].byteLength, 13 * 96); // twelve source folds + folder frame
  const records = new DataView(result.flights[0]),
    source = new DataView(original);
  let offset = 96;
  for (let i = 1; i < 3; i++) {
    const n = readNode(source, i),
      s = surface(n);
    for (let panel = 0; panel < s.panels; panel++) {
      const b = s.panel(panel);
      for (let row = b.start; row < b.start + b.count; row += 96) {
        const f = foldAt(n, row, 0);
        for (const [axis, target] of [
          [0, f.x],
          [1, f.y],
          [2, f.z],
        ])
          assert.ok(
            Math.abs(
              records.getFloat32(offset + axis * 4, true) +
                records.getFloat32(offset + 16 + axis * 4, true) -
                target,
            ) < 1e-6,
          );
        assert.equal(records.getUint32(offset + 64, true), i);
        assert.equal(records.getUint32(offset + 68, true), n.preview + panel * 16);
        assert.equal(records.getUint32(offset + 72, true), f.local);
        assert.equal(records.getUint32(offset + 76, true), f.count);
        offset += 96;
      }
    }
  }
  const bases = new Float64Array(result.bases),
    tops = new Float64Array(result.tops);
  assert.equal(bases[0], Math.min(bases[1], bases[2]));
  assert.equal(tops[0], Math.max(tops[1], tops[2]));
});
