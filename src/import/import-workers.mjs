import { WorkerRPC } from '../shared/worker-rpc.mjs';
import { importWorkerCount } from './import-queue.mjs';

export class ImportWorkers {
  constructor({
    size = importWorkerCount(globalThis.navigator),
    WorkerType = globalThis.Worker,
  } = {}) {
    this.size = WorkerType ? size : 1;
    this.WorkerType = WorkerType;
    this.workers = [];
  }
  async process(file, slot) {
    if (this.closed) throw this.closed;
    if (!this.WorkerType) {
      const { indexDocument } = await import('./index-document.mjs');
      return indexDocument(file);
    }
    const rpc = (this.workers[slot] ??= new WorkerRPC(
      new URL('./index-worker.mjs', import.meta.url),
      this.WorkerType,
    ));
    return rpc.request('index', file);
  }
  close(error = Error('Import workers closed')) {
    this.closed ??= error;
    for (const rpc of this.workers) rpc?.close(this.closed);
  }
}
