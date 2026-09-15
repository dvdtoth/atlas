import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRPC } from '../src/shared/worker-rpc.mjs';
class FakeWorker {
  constructor() {
    this.messages = [];
    this.terminated = false;
  }
  postMessage(message) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}
test('closing a worker rejects pending and all future work rather than hanging imports', async () => {
  const rpc = new WorkerRPC('unused', FakeWorker),
    pending = rpc.request('open');
  rpc.close();
  await assert.rejects(pending, /closed/);
  const state = await Promise.race([
    rpc.request('import').then(
      () => 'resolved',
      (e) => e.message,
    ),
    new Promise((r) => setTimeout(() => r('hung'), 40)),
  ]);
  assert.match(state, /closed/);
  assert.equal(rpc.worker.messages.length, 1);
});
test('cancellation sends an abort message and ignores the late worker reply', async () => {
  const rpc = new WorkerRPC('unused', FakeWorker),
    controller = new AbortController(),
    pending = rpc.request('search', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(rpc.worker.messages[1].type, 'cancel');
  rpc.worker.onmessage({ data: { id: 1, value: 'stale' } });
  assert.equal(rpc.pending.size, 0);
});
test('progress does not settle a request before its result', async () => {
  const rpc = new WorkerRPC('unused', FakeWorker),
    events = [];
  const p = rpc.request('import', {}, { onProgress: (x) => events.push(x) });
  rpc.worker.onmessage({ data: { type: 'progress', id: 1, value: { completed: 3 } } });
  assert.equal(rpc.pending.size, 1);
  rpc.worker.onmessage({ data: { type: 'result', id: 1, value: 'ready' } });
  assert.equal(await p, 'ready');
  assert.equal(events[0].completed, 3);
});

test('import startup deadline rejects a worker that never responds', { timeout: 100 }, async () => {
  const rpc = new WorkerRPC('unused', FakeWorker);
  await assert.rejects(
    rpc.request('import', {}, { initialResponseTimeoutMs: 5 }),
    /did not respond.*Refresh/i,
  );
  assert.equal(rpc.worker.terminated, true);
  assert.equal(rpc.pending.size, 0);
});
test('first worker progress clears the startup deadline without limiting a long import', async () => {
  const rpc = new WorkerRPC('unused', FakeWorker),
    pending = rpc.request('import', {}, { initialResponseTimeoutMs: 5 });
  rpc.worker.onmessage({ data: { type: 'progress', id: 1, value: { stage: 'storage' } } });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(rpc.worker.terminated, false);
  rpc.worker.onmessage({ data: { type: 'result', id: 1, value: 'ready' } });
  assert.equal(await pending, 'ready');
  rpc.close();
});
