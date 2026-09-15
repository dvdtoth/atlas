import test from 'node:test';
import assert from 'node:assert/strict';
import { CachedZipReader } from '../src/import/zip-reader.mjs';

function fixture(size = 512) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251),
    reads = [];
  class ObservedBlob extends Blob {
    slice(start, end) {
      reads.push([start, end]);
      return super.slice(start, end);
    }
  }
  return { bytes, reads, blob: new ObservedBlob([bytes]) };
}
test('cached ZIP ranges preserve bytes across pages and return independent copies', async () => {
  const { bytes, reads, blob } = fixture(),
    reader = new CachedZipReader(blob, { pageBytes: 64, maxPages: 2 });
  assert.deepEqual(await reader.readUint8Array(60, 12), bytes.slice(60, 72));
  const copy = await reader.readUint8Array(0, 8);
  copy[0] = 255;
  assert.deepEqual(await reader.readUint8Array(0, 8), bytes.slice(0, 8));
  assert.equal(reads.length, 2);
  assert.deepEqual(await reader.readUint8Array(508, 100), bytes.slice(508));
  assert.equal((await reader.readUint8Array(600, 8)).length, 0);
});
test('ZIP page cache evicts old pages and coalesces concurrent overlapping reads', async () => {
  const { blob, reads } = fixture(),
    reader = new CachedZipReader(blob, { pageBytes: 64, maxPages: 2 });
  await Promise.all([reader.readUint8Array(0, 30), reader.readUint8Array(8, 20)]);
  assert.equal(reads.length, 1);
  for (const offset of [64, 128, 192, 0]) await reader.readUint8Array(offset, 1);
  assert.equal(reads.length, 5);
  assert.ok(reads.every(([a, b]) => b - a <= 64));
});
test('cached ZIP reader rejects invalid ranges and stops both cached and queued reads on abort', async () => {
  const { blob, reads } = fixture(),
    controller = new AbortController(),
    reader = new CachedZipReader(blob, { signal: controller.signal, pageBytes: 64, maxPages: 2 });
  for (const args of [
    [-1, 2],
    [0, -1],
    [0.5, 2],
    [0, Infinity],
  ])
    await assert.rejects(reader.readUint8Array(...args), /range/i);
  await reader.readUint8Array(0, 1);
  controller.abort();
  await assert.rejects(reader.readUint8Array(0, 1), (e) => e.name === 'AbortError');
  assert.equal(reads.length, 1);
  reader.close();
  await assert.rejects(reader.readUint8Array(0, 1));
});
