export function importWorkerCount({ hardwareConcurrency = 4, deviceMemory } = {}) {
  const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 4;
  return Math.max(1, Math.min(deviceMemory && deviceMemory <= 4 ? 2 : 4, Math.floor(cores / 2)));
}

// Admission is ordered even when several download callbacks arrive together.
// Worker slots can be reused before ordered consumption, but both source-byte
// credit and a result-count window remain occupied until consumption finishes.
export class OrderedImportQueue {
  constructor({
    concurrency = 1,
    maxPending = concurrency,
    maxBytes = 32 * 1024 ** 2,
    process,
    consume,
    signal,
  } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw Error('Invalid import concurrency');
    if (!Number.isInteger(maxPending) || maxPending < concurrency || maxPending > 64)
      throw Error('Invalid import result window');
    if (!Number.isFinite(maxBytes) || maxBytes < 1) throw Error('Invalid import byte budget');
    this.free = Array.from({ length: concurrency }, (_, i) => i);
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.count = 0;
    this.maxPending = maxPending;
    this.process = process;
    this.consume = consume;
    this.signal = signal;
    this.waiters = new Set();
    this.admission = Promise.resolve();
    this.tail = Promise.resolve();
    this.error = null;
    this.abort = () => this.cancel(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  check() {
    if (this.error) throw this.error;
    this.signal?.throwIfAborted();
  }
  wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  cancel(error = new DOMException('Cancelled', 'AbortError')) {
    this.error ??= error;
    this.wake();
  }
  submit(file) {
    const admission = this.admission.then(async () => {
      this.check();
      const bytes = Math.max(1, file.bytes || 0);
      if (bytes > this.maxBytes) throw Error('File exceeds the in-flight import byte budget');
      while (
        !this.free.length ||
        this.count >= this.maxPending ||
        this.bytes + bytes > this.maxBytes
      ) {
        await new Promise((resolve) => this.waiters.add(resolve));
        this.check();
      }
      const slot = this.free.shift();
      this.bytes += bytes;
      this.count++;
      const result = Promise.resolve()
        .then(() => this.process(file, slot))
        .then(
          (value) => ({ value }),
          (error) => {
            this.cancel(error);
            return { error };
          },
        )
        .finally(() => {
          this.free.push(slot);
          this.wake();
        });
      this.tail = this.tail
        .then(async () => {
          const outcome = await result;
          if (outcome.error) throw outcome.error;
          this.check();
          await this.consume(outcome.value);
        })
        .catch((error) => this.cancel(error))
        .finally(() => {
          this.bytes -= bytes;
          this.count--;
          this.wake();
        });
    });
    this.admission = admission.catch((error) => this.cancel(error));
    return admission;
  }
  async finish() {
    try {
      await this.admission;
      await this.tail;
      this.check();
    } finally {
      this.signal?.removeEventListener('abort', this.abort);
    }
  }
}
