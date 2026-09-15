import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { ImportWorkers } from '../src/import/import-workers.mjs';
import { indexDocument } from '../src/import/index-document.mjs';
import { ClientStore } from '../src/index/client-store.mjs';
import { importProject } from '../src/import/import-project.mjs';

// Run the actual web worker entry point and transferred messages on real threads.
class BrowserWorker {
  constructor(url) {
    this.worker = new NodeWorker(
      `const {parentPort}=await import('node:worker_threads');globalThis.postMessage=(value,transfer)=>parentPort.postMessage(value,transfer);await import(${JSON.stringify(url.href)});parentPort.on('message',data=>globalThis.onmessage({data}));`,
      { eval: true },
    );
    this.worker.on('message', (data) => this.onmessage?.({ data }));
    this.worker.on('error', (e) => this.onerror?.(e));
  }
  postMessage(value) {
    this.worker.postMessage(value);
  }
  terminate() {
    this.worker.terminate();
  }
}
const text = '\ufeffexport function café(name) {\r\n  return `Hello ${name}`;\r\n}\r\n';
const file = (id) => ({
  id,
  path: `src/${id}.js`,
  text,
  bytes: new TextEncoder().encode(text).length,
  revision: `revision-${id}`,
});
test('real parallel workers return exact source, transferable profiles and matching syntax', async () => {
  const pool = new ImportWorkers({ size: 2, WorkerType: BrowserWorker });
  try {
    const actual = await Promise.all([pool.process(file(1), 0), pool.process(file(2), 1)]);
    for (let i = 0; i < actual.length; i++)
      assert.deepEqual(actual[i], await indexDocument(file(i + 1)));
    assert.equal(pool.workers.length, 2);
    assert.ok(actual[0].doc.rawProfile.byteLength > 0);
  } finally {
    pool.close();
  }
});
test('closing real workers rejects outstanding jobs and disallows new work', async () => {
  const pool = new ImportWorkers({ size: 2, WorkerType: BrowserWorker });
  const pending = pool.process(file(1), 0);
  pool.close(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  await assert.rejects(pool.process(file(2), 1), (e) => e.name === 'AbortError');
});
test('parallel imports match serial map, source IDs and capped symbols despite reversed completion', async () => {
  const store = await ClientStore.open('parallel-' + crypto.randomUUID());
  const source = Array.from({ length: 70 }, (_, i) => new File([text], `file-${i}.js`));
  let started = 0,
    active = 0,
    peak = 0,
    closed = false,
    writes = 0;
  const original = store.putDocuments.bind(store);
  store.putDocuments = async (...args) => {
    writes++;
    return original(...args);
  };
  const indexer = {
    size: 4,
    async process(file) {
      started++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, file.id % 4 === 1 ? 5 : 0));
      const result = await indexDocument(file);
      active--;
      return result;
    },
    close() {
      closed = true;
    },
  };
  try {
    await importProject(
      store,
      { projectId: 'parallel', input: 'sample', files: source },
      { indexer, maxSymbols: 3 },
    );
    assert.ok(peak > 1);
    assert.equal(started, 70);
    assert.equal(closed, true);
    assert.equal(writes, 3);
    await importProject(
      store,
      { projectId: 'serial', input: 'sample', files: source },
      { maxSymbols: 3 },
    );
    const a = await store.snapshot('parallel'),
      b = await store.snapshot('serial');
    for (const key of ['nodes', 'paths', 'previews'])
      assert.deepEqual(new Uint8Array(a[key]), new Uint8Array(b[key]));
    assert.deepEqual(await store.index('parallel'), await store.index('serial'));
    for (let id = 1; id <= 70; id++)
      assert.deepEqual(await store.document('parallel', id), await store.document('serial', id));
  } finally {
    store.close();
  }
});
test('parallel failure waits for running consumers before clearing partial source', async () => {
  const store = await ClientStore.open('parallel-failure-' + crypto.randomUUID()),
    source = Array.from({ length: 80 }, (_, i) => new File([text], `file-${i}.js`));
  const indexer = {
    size: 4,
    async process(file) {
      if (file.id === 40) throw Error('parser worker failed');
      await new Promise(setImmediate);
      return indexDocument(file);
    },
    close() {},
  };
  try {
    await assert.rejects(
      importProject(store, { projectId: 'failed', input: 'sample', files: source }, { indexer }),
      /parser worker failed/,
    );
    assert.equal((await store.project('failed')).state, 'failed');
    assert.equal(await store.document('failed', 1), undefined);
    await assert.rejects(store.snapshot('failed'), /ready/);
    await new Promise(setImmediate);
    assert.equal(await store.document('failed', 35), undefined);
  } finally {
    store.close();
  }
});
