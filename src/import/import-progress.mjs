// Preserve counted work across interleaved parser/extraction messages, before
// the worker's 10 Hz UI throttle. Different stages never share a rate/total.
export function createImportProgressReporter(send) {
  let work = { phase: 'preparing', completed: 0, total: 0 };
  return (value) => {
    if (['reading', 'download', 'previews'].includes(value.stage)) {
      work = {
        phase: value.stage === 'previews' ? 'previews' : 'source',
        completed: value.completed,
        total: value.total,
      };
    } else if (
      ['storage', 'resolve', 'list', 'archive', 'layout', 'saving'].includes(value.stage)
    ) {
      work = { phase: value.stage, completed: 0, total: 0 };
    }
    send({ ...value, work });
  };
}

const STALE_MS = 8000;
export function importStage(value, previous = 'cache') {
  return previous === 'build' ||
    ['layout', 'previews', 'saving'].includes(value.work?.phase || value.stage)
    ? 'build'
    : 'cache';
}
export function importMessage(stage) {
  return stage === 'build'
    ? 'Building the searchable code map…'
    : 'Reading and caching source on this device…';
}
export class ImportProgressTimer {
  constructor(started = performance.now()) {
    this.started = started;
    this.work = { phase: 'preparing', completed: 0, total: 0 };
    this.samples = [];
  }
  update({ work }, now = performance.now()) {
    if (!work) return;
    const { phase, completed, total } = work;
    if (!Number.isFinite(completed) || !Number.isFinite(total) || completed < 0 || total < 0)
      return;
    const last = this.samples.at(-1);
    if (
      phase !== this.work.phase ||
      total !== this.work.total ||
      completed < this.work.completed ||
      (last && now - last.time > STALE_MS && completed > last.completed)
    )
      this.samples = [];
    this.work = { phase, completed: Math.min(completed, total), total };
    if (total > 0 && (!this.samples.length || completed > this.samples.at(-1).completed)) {
      this.samples.push({ time: now, completed: this.work.completed });
      // A bounded ten-second rolling rate smooths bursts without retaining a
      // repository-sized history. Keep one sample at the window's leading edge.
      while (
        this.samples.length > 120 ||
        (this.samples.length > 2 && this.samples[1].time < now - 10000)
      )
        this.samples.shift();
    }
  }
  snapshot(now = performance.now()) {
    const { phase, completed, total } = this.work;
    const state = {
      elapsedSeconds: Math.max(0, Math.floor((now - this.started) / 1000)),
      phase,
      status: 'estimating',
      remainingSeconds: null,
    };
    if (!total) return state;
    if (completed >= total) return { ...state, status: 'finishing' };
    const first = this.samples[0],
      last = this.samples.at(-1);
    if (last && now - last.time > STALE_MS) return { ...state, status: 'waiting' };
    if (this.samples.length < 3 || last.time - first.time < 2000) return state;
    // Include time since the last completed item: an expensive file or slow IO
    // increases the estimate instead of letting a blind countdown reach zero.
    const rate = (last.completed - first.completed) / (now - first.time);
    if (!(rate > 0)) return state;
    return { ...state, status: 'estimated', remainingSeconds: (total - completed) / rate / 1000 };
  }
}

export function formatDuration(seconds) {
  const n = Math.max(0, Math.floor(seconds)),
    s = n % 60,
    m = Math.floor(n / 60) % 60,
    h = Math.floor(n / 3600);
  return h
    ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    : m
      ? `${m}m ${String(s).padStart(2, '0')}s`
      : `${s}s`;
}
export function formatImportETA({ phase, status, remainingSeconds }) {
  if (status === 'estimated') {
    const step =
      remainingSeconds >= 3600 ? 60 : remainingSeconds >= 60 ? 15 : remainingSeconds >= 10 ? 5 : 1;
    return `~${formatDuration(Math.max(1, Math.ceil(remainingSeconds / step) * step))} · ${phase === 'previews' ? 'previews' : 'source'}`;
  }
  if (status === 'waiting') return 'Waiting for progress…';
  if (status === 'finishing')
    return phase === 'previews' ? 'Finishing previews…' : 'Finishing source…';
  if (phase === 'layout') return 'Packing folders…';
  if (phase === 'saving') return 'Saving map…';
  return 'Estimating…';
}
