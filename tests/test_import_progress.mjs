import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImportProgressReporter,
  ImportProgressTimer,
  formatDuration,
  formatImportETA,
} from '../src/import/import-progress.mjs';

test('interleaved worker messages retain source counters before UI throttling', () => {
  const events = [],
    report = createImportProgressReporter((p) => events.push(p));
  report({ stage: 'reading', completed: 10, total: 100 });
  report({ stage: 'indexing', completed: 8 });
  report({ stage: 'unpacking' });
  report({ stage: 'retry', completed: 0, total: 0 });
  assert.deepEqual(
    events.map((p) => p.work),
    Array(4).fill({ phase: 'source', completed: 10, total: 100 }),
  );
  report({ stage: 'layout', completed: 0, total: 100 });
  assert.deepEqual(events.at(-1).work, { phase: 'layout', completed: 0, total: 0 });
  report({ stage: 'previews', completed: 25, total: 100 });
  assert.deepEqual(events.at(-1).work, { phase: 'previews', completed: 25, total: 100 });
  report({ stage: 'saving' });
  assert.equal(events.at(-1).work.total, 0);
  assert.equal(events[0].work.completed, 10, 'earlier progress snapshots stay immutable');
});

const progress = (completed, total = 100, phase = 'source') => ({
  work: { phase, completed, total },
});
test('ETA waits for a measured rate and elapsed time includes uncounted startup', () => {
  const timer = new ImportProgressTimer(1000);
  assert.equal(timer.snapshot(6000).elapsedSeconds, 5);
  assert.equal(formatImportETA(timer.snapshot(6000)), 'Estimating…');
  timer.update(progress(10), 6000);
  timer.update(progress(20), 7000);
  assert.equal(timer.snapshot(7000).remainingSeconds, null);
  timer.update(progress(30), 8000);
  assert.equal(timer.snapshot(8000).remainingSeconds, 7);
  assert.match(formatImportETA(timer.snapshot(8000)), /~7s · source/);
  assert.equal(timer.snapshot(8000).elapsedSeconds, 7);
});

test('stalls never count down to zero and resuming starts a fresh estimate', () => {
  const timer = new ImportProgressTimer(0);
  timer.update(progress(10), 0);
  timer.update(progress(20), 1000);
  timer.update(progress(30), 2000);
  assert.ok(timer.snapshot(5000).remainingSeconds > timer.snapshot(2000).remainingSeconds);
  assert.equal(timer.snapshot(11000).remainingSeconds, null);
  assert.match(formatImportETA(timer.snapshot(11000)), /Waiting for progress/);
  timer.update(progress(40), 12000);
  assert.equal(timer.snapshot(12000).remainingSeconds, null);
  timer.update(progress(50), 13000);
  timer.update(progress(60), 14000);
  assert.equal(timer.snapshot(14000).remainingSeconds, 4);
});

test('phase changes and revised totals discard old rates; completed stages are finishing', () => {
  const timer = new ImportProgressTimer(0);
  timer.update(progress(10), 0);
  timer.update(progress(20), 1000);
  timer.update(progress(30), 2000);
  timer.update(progress(40, 200), 3000);
  assert.equal(timer.snapshot(3000).remainingSeconds, null);
  timer.update(progress(5, 100, 'previews'), 4000);
  assert.equal(timer.snapshot(4000).remainingSeconds, null);
  timer.update(progress(15, 100, 'previews'), 5000);
  timer.update(progress(25, 100, 'previews'), 6000);
  assert.equal(timer.snapshot(6000).remainingSeconds, 7.5);
  timer.update(progress(100, 100, 'previews'), 7000);
  assert.equal(timer.snapshot(7000).remainingSeconds, null);
  assert.match(formatImportETA(timer.snapshot(7000)), /Finishing previews/);
  timer.update(progress(0, 0, 'saving'), 8000);
  assert.equal(formatImportETA(timer.snapshot(8000)), 'Saving map…');
  assert.equal(timer.snapshot(8000).elapsedSeconds, 8);
});

test('duration display handles long imports and ETA rounds away false precision', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(formatDuration(3661), '1h 01m 01s');
  assert.equal(
    formatImportETA({ phase: 'source', status: 'estimated', remainingSeconds: 22.1 }),
    '~25s · source',
  );
  assert.equal(
    formatImportETA({ phase: 'previews', status: 'estimated', remainingSeconds: 69 }),
    '~1m 15s · previews',
  );
});
