import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../src/render/text-budget.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const capable = { deviceMemory: 8, hardwareConcurrency: 12, maxBufferSize: 256 * 1048576 };

test('text budgets distinguish modest, unknown and capable browsers without treating buffer limits as RAM', () => {
  assert.equal(typeof api.AdaptiveTextBudget, 'function');
  const low = new api.AdaptiveTextBudget({ ...capable, deviceMemory: 2 });
  const unknown = new api.AdaptiveTextBudget({ maxBufferSize: 2 ** 32 });
  const high = new api.AdaptiveTextBudget(capable);
  assert.ok(low.current.cacheBytes < unknown.current.cacheBytes);
  assert.ok(high.current.maxDraws > 512);
  assert.ok(high.current.cacheBytes > 320 * 1048576);
  assert.ok(high.current.cacheBytes <= 640 * 1048576);
  assert.equal(unknown.current.name, 'balanced');
  assert.equal(new api.AdaptiveTextBudget({ ...capable, fallback: true }).current.name, 'light');
  for (const b of [low, unknown, high]) assert.ok(b.current.workingBytes < b.current.cacheBytes);
});

test('sustained pressure lowers detail but a single slow sample and alternating noise do not', () => {
  const b = new api.AdaptiveTextBudget(capable),
    initial = b.current.maxDraws;
  const sample = (now, queueMs, cpuMs = 1) => b.observe({ now, queueMs, cpuMs });
  sample(1000, 40);
  sample(2000, 2);
  sample(3000, 40);
  sample(4000, 2);
  assert.equal(b.current.maxDraws, initial);
  sample(5000, 40);
  sample(6000, 40);
  assert.equal(sample(7000, 40), true);
  assert.ok(b.current.maxDraws < initial);
  for (let now = 8000; now <= 12000; now += 1000) sample(now, 2);
  assert.ok(b.current.maxDraws < initial, 'cooldown prevents immediate rebound');
  for (let now = 16000; now <= 22000; now += 1000) sample(now, 2);
  assert.equal(b.current.maxDraws, initial);
});

test('missing timing, background samples and long sampling gaps cannot falsely promote detail', () => {
  const b = new api.AdaptiveTextBudget({ hardwareConcurrency: 12 }),
    initial = b.current.maxDraws;
  for (let now = 1000; now <= 12000; now += 1000)
    b.observe({ now, queueMs: 1, cpuMs: 1, visible: false });
  for (let now = 13000; now <= 22000; now += 1000) b.observe({ now, cpuMs: 1 });
  for (let now = 30000; now <= 150000; now += 10000) b.observe({ now, cpuMs: 1, queueMs: 1 });
  assert.equal(b.current.maxDraws, initial);
  for (let now = 151000; now <= 157000; now += 1000) b.observe({ now, cpuMs: 1, queueMs: 1 });
  assert.ok(b.current.maxDraws > initial);
});

test('adaptation respects memory and GPU allocation ceilings under arbitrary timing samples', () => {
  const b = new api.AdaptiveTextBudget({
    deviceMemory: 2,
    hardwareConcurrency: 64,
    maxBufferSize: 65536,
  });
  for (let now = 1000; now < 100000; now += 1000) {
    b.observe({ now, cpuMs: 1, queueMs: 1 });
    assert.ok(b.current.maxDraws * 256 <= 65536);
    assert.ok(b.current.cacheBytes <= 160 * 1048576);
  }
});
