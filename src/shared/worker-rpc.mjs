export class WorkerRPC {
  constructor(url, WorkerType = Worker) {
    this.worker = new WorkerType(url, { type: 'module' });
    this.pending = new Map();
    this.next = 0;
    this.worker.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      entry.clearStartup();
      if (data.type === 'progress') {
        entry.onProgress?.(data.value);
        return;
      }
      this.pending.delete(data.id);
      entry.cleanup();
      if (data.type === 'error') {
        const error = Error(data.error);
        error.name = data.name || 'Error';
        entry.reject(error);
      } else entry.resolve(data.value);
    };
    this.worker.onerror = (event) => this.close(Error(event.message || 'A browser worker failed'));
  }
  request(method, args = {}, options = {}) {
    if (this.closed) return Promise.reject(this.closed);
    if (options.signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      let startupTimer;
      const clearStartup = () => {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      };
      const cleanup = () => {
        clearStartup();
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        this.worker.postMessage({ type: 'cancel', id });
        this.pending.delete(id);
        cleanup();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      this.pending.set(id, {
        resolve,
        reject,
        cleanup,
        clearStartup,
        onProgress: options.onProgress,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.initialResponseTimeoutMs > 0)
        startupTimer = setTimeout(
          () =>
            this.close(
              Error(
                'The browser worker did not respond during startup. Refresh Atlas and try the import again.',
              ),
            ),
          options.initialResponseTimeoutMs,
        );
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }
  close(reason = Error('Worker closed')) {
    if (this.closed) return;
    this.closed = reason;
    this.worker.terminate();
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(reason);
    }
    this.pending.clear();
  }
}
export function serveWorker(
  handler,
  {
    transfer = (method, value) =>
      method === 'open' ? [value.nodes, value.paths, value.previews] : [],
  } = {},
) {
  const jobs = new Map();
  globalThis.onmessage = async ({ data }) => {
    if (data.type === 'cancel') {
      jobs.get(data.id)?.abort();
      return;
    }
    const controller = new AbortController();
    jobs.set(data.id, controller);
    try {
      const value = await handler(data.method, data.args, {
        signal: controller.signal,
        onProgress: (value) => postMessage({ type: 'progress', id: data.id, value }),
      });
      controller.signal.throwIfAborted();
      postMessage({ type: 'result', id: data.id, value }, transfer(data.method, value));
    } catch (error) {
      postMessage({
        type: 'error',
        id: data.id,
        error: String(error.message || error),
        name: error.name,
      });
    } finally {
      jobs.delete(data.id);
    }
  };
}
