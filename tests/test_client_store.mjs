import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStore } from '../src/index/client-store.mjs';
test('ready publication atomically stores snapshot and metadata, preserving isolated source', async () => {
  const s = await ClientStore.open('test-' + crypto.randomUUID());
  await s.createProject({ id: 'a', fullName: 'org/a' });
  await s.createProject({ id: 'b', fullName: 'org/b' });
  await s.putDocument('a', { id: 1, text: 'alpha' });
  await s.putDocument('b', { id: 1, text: 'beta' });
  await assert.rejects(s.snapshot('a'), /ready/);
  await s.publish(
    'a',
    {
      manifest: { stats: { files: 1 } },
      nodes: new ArrayBuffer(96),
      paths: new ArrayBuffer(2),
      previews: new ArrayBuffer(4),
    },
    [{ id: 1, path: 'a.js' }],
    [],
  );
  assert.equal((await s.project('a')).state, 'ready');
  assert.equal((await s.snapshot('a')).nodes.byteLength, 96);
  assert.equal((await s.document('b', 1)).text, 'beta');
  assert.equal((await s.document('a', 1)).text, 'alpha');
  await s.deleteProject('a');
  assert.equal(await s.project('a'), undefined);
  assert.equal(await s.document('a', 1), undefined);
  assert.equal((await s.document('b', 1)).text, 'beta');
  s.close();
});
test('cancelled state cannot publish and incomplete sources can be reclaimed', async () => {
  const s = await ClientStore.open('test-' + crypto.randomUUID());
  await s.createProject({ id: 'a' });
  await s.putDocument('a', { id: 1, text: 'discard' });
  await s.updateProject('a', { state: 'cancelled' });
  await assert.rejects(s.publish('a', {}, [], []), /cancelled/);
  await s.clearDocuments('a');
  assert.equal(await s.document('a', 1), undefined);
  assert.equal((await s.project('a')).state, 'cancelled');
  s.close();
});
test('reopening preserves committed data and lists newest projects first', async () => {
  const name = 'test-' + crypto.randomUUID();
  let s = await ClientStore.open(name);
  await s.createProject({ id: 'a', createdAt: 1 });
  await s.createProject({ id: 'b', createdAt: 2 });
  s.close();
  s = await ClientStore.open(name);
  assert.deepEqual(
    (await s.projects()).map((x) => x.id),
    ['b', 'a'],
  );
  s.close();
});

test('document batches persist together and clone source before callers release buffers', async () => {
  const store = await ClientStore.open('batch-' + crypto.randomUUID());
  try {
    const first = { id: 1, text: 'one', rawProfile: new Uint32Array([42]) },
      second = { id: 2, text: 'two' };
    const saving = store.putDocuments('batch', [first, second]);
    first.rawProfile[0] = 99;
    await saving;
    assert.equal((await store.document('batch', 1)).rawProfile[0], 42);
    assert.equal((await store.document('batch', 2)).text, 'two');
  } finally {
    store.close();
  }
});
