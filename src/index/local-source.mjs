import { ClientStore } from './client-store.mjs';
import { documentPage, sourceAddress, sourceSelection } from './client-index.mjs';
export class LocalSource {
  constructor(store, project, maxBytes = 32 * 1048576) {
    this.store = store;
    this.project = project;
    this.maxBytes = maxBytes;
    this.cache = new Map();
    this.bytes = 0;
    this.pending = new Map();
  }
  async get(id) {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit.doc;
    }
    if (this.pending.has(id)) return this.pending.get(id);
    const promise = (async () => {
      const doc = await this.store.document(this.project, id);
      if (!doc) throw Error('Source is missing from local storage. Import this repository again.');
      const bytes =
        doc.text.length * 2 +
        (doc.rawProfile?.byteLength || 0) +
        (doc.displayProfile?.byteLength || 0) +
        (doc.lineOffsets?.byteLength || 0);
      if (bytes <= this.maxBytes) {
        while (this.bytes + bytes > this.maxBytes && this.cache.size) {
          const [key, entry] = this.cache.entries().next().value;
          this.cache.delete(key);
          this.bytes -= entry.bytes;
        }
        this.cache.set(id, { doc, bytes });
        this.bytes += bytes;
      }
      return doc;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, promise);
    return promise;
  }
  async request(route, args = {}) {
    const doc = await this.get(Number(args.id));
    if (route === 'document')
      return documentPage(doc, {
        start: Number(args.start || 0),
        count: Number(args.count || 32),
        display: args.display === true || args.display === '1' || args.display === 1,
      });
    if (route === 'address')
      return sourceAddress(doc, { line: Number(args.line || 0), column: Number(args.column || 0) });
    if (route === 'selection')
      return sourceSelection(doc, {
        line: Number(args.line || 0),
        column: Number(args.column || 0),
        endLine: args.endLine === undefined ? undefined : Number(args.endLine),
        endColumn: args.endColumn === undefined ? undefined : Number(args.endColumn),
      });
    if (route === 'segments') return { id: doc.id, revision: doc.revision, ...doc.structure };
    throw Error('Unknown local source operation');
  }
  static async open(project) {
    const store = await ClientStore.open();
    const p = await store.project(project);
    if (p?.state !== 'ready') throw Error('Repository is not ready');
    return new LocalSource(store, project);
  }
}
