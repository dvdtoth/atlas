import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderedImportQueue, importWorkerCount } from '../src/import/import-queue.mjs';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);

test('parallel index jobs overlap, preserve input order, and exert backpressure until consumed', async () => {
  const gates = [deferred(), deferred(), deferred()],
    started = [],
    consumed = [];
  const queue = new OrderedImportQueue({
    concurrency: 2,
    maxBytes: 100,
    process: async (file, slot) => {
      started.push([file.id, slot]);
      return gates[file.id].promise;
    },
    consume: async (value) => consumed.push(value),
  });
  await queue.submit({ id: 0, bytes: 10 });
  await queue.submit({ id: 1, bytes: 10 });
  let admitted = false;
  const third = queue.submit({ id: 2, bytes: 10 }).then(() => (admitted = true));
  await tick();
  assert.equal(started.length, 2);
  assert.equal(admitted, false);
  gates[1].resolve(1);
  await tick();
  assert.deepEqual(consumed, []);
  assert.equal(admitted, false);
  gates[0].resolve(0);
  await third;
  await tick();
  assert.deepEqual(consumed, [0, 1]);
  assert.equal(started.length, 3);
  gates[2].resolve(2);
  await queue.finish();
  assert.deepEqual(consumed, [0, 1, 2]);
});
test('source byte budget bounds in-flight jobs independently of worker count', async () => {
  const gates = [deferred(), deferred()],
    started = [];
  const queue = new OrderedImportQueue({
    concurrency: 4,
    maxBytes: 10,
    process: (file) => {
      started.push(file.id);
      return gates[file.id].promise;
    },
    consume: async () => {},
  });
  await queue.submit({ id: 0, bytes: 8 });
  let admitted = false;
  const next = queue.submit({ id: 1, bytes: 8 }).then(() => (admitted = true));
  await tick();
  assert.equal(admitted, false);
  gates[0].resolve({});
  await next;
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve({});
  await queue.finish();
});
test('failure wakes blocked producers, stops later storage, and is propagated by finish', async () => {
  const gates = [deferred(), deferred()],
    consumed = [];
  const queue = new OrderedImportQueue({
    concurrency: 2,
    process: (file) => gates[file.id].promise,
    consume: async (d) => consumed.push(d),
  });
  await queue.submit({ id: 0, bytes: 1 });
  await queue.submit({ id: 1, bytes: 1 });
  const waiting = queue.submit({ id: 2, bytes: 1 });
  const rejected = assert.rejects(waiting, /broken/);
  gates[1].reject(Error('broken'));
  await rejected;
  gates[0].resolve(0);
  await assert.rejects(queue.finish(), /broken/);
  assert.deepEqual(consumed, []);
});
test('abort stops queued writes and settles producers without unhandled task rejection', async () => {
  const gate = deferred();
  const queue = new OrderedImportQueue({
    concurrency: 1,
    process: () => gate.promise,
    consume: () => assert.fail('must not write'),
  });
  await queue.submit({ bytes: 1 });
  const waiting = queue.submit({ bytes: 1 }),
    rejected = assert.rejects(waiting, (e) => e.name === 'AbortError');
  const error = new DOMException('Cancelled', 'AbortError');
  queue.cancel(error);
  gate.reject(error);
  await rejected;
  await assert.rejects(queue.finish(), (e) => e.name === 'AbortError');
});
test('worker count leaves CPU headroom and caps parser duplication', () => {
  assert.equal(importWorkerCount({ hardwareConcurrency: 16, deviceMemory: 8 }), 4);
  assert.equal(importWorkerCount({ hardwareConcurrency: 8, deviceMemory: 2 }), 2);
  assert.equal(importWorkerCount({ hardwareConcurrency: 2 }), 1);
  assert.equal(importWorkerCount({}), 2);
});

test('a slow first result does not idle other workers within a bounded result window', async () => {
  const gate = deferred(),
    started = [],
    consumed = [];
  const queue = new OrderedImportQueue({
    concurrency: 2,
    maxPending: 4,
    maxBytes: 100,
    process: async (file, slot) => {
      started.push([file.id, slot]);
      return file.id === 0 ? gate.promise : file.id;
    },
    consume: async (value) => consumed.push(value),
  });
  const submissions = Array.from({ length: 5 }, (_, id) => queue.submit({ id, bytes: 1 }));
  for (let i = 0; i < 10 && started.length < 4; i++) await tick();
  assert.deepEqual(
    started.map(([id]) => id),
    [0, 1, 2, 3],
  );
  assert.deepEqual(consumed, []);
  assert.equal(new Set(started.slice(1).map(([, slot]) => slot)).size, 1);
  gate.resolve(0);
  await Promise.all(submissions);
  await queue.finish();
  assert.deepEqual(consumed, [0, 1, 2, 3, 4]);
});

test('completed out-of-order results keep byte credit until ordered consumption', async () => {
  const gate = deferred(),
    started = [];
  const queue = new OrderedImportQueue({
    concurrency: 2,
    maxPending: 8,
    maxBytes: 6,
    process: async (file) => {
      started.push(file.id);
      return file.id === 0 ? gate.promise : file.id;
    },
    consume: async () => {},
  });
  const jobs = Array.from({ length: 4 }, (_, id) => queue.submit({ id, bytes: 2 }));
  for (let i = 0; i < 10 && started.length < 3; i++) await tick();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gate.resolve(0);
  await Promise.all(jobs);
  await queue.finish();
  assert.deepEqual(started, [0, 1, 2, 3]);
});
