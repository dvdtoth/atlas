// Whole-map filename search. All input is transferred cached metadata; no IO.
// Init: {type:'init',nodes:Uint32Array triples [id,pathOffset,pathLength],paths:ArrayBuffer}
// Search: {type:'search',token,query,limit:40}; only the latest token is published.
const defaultYield = () =>
  globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

// Positive means a is a better result. A bounded min-heap retains the best K
// while total still counts every matching document, including late exact names.
function compare(a, b) {
  if (a.score !== b.score) return a.score - b.score;
  if (a.path !== b.path) return a.path < b.path ? 1 : -1;
  return b.id - a.id;
}
function retain(heap, candidate, limit) {
  if (heap.length < limit) {
    let i = heap.length;
    heap.push(candidate);
    while (i) {
      const parent = (i - 1) >> 1;
      if (compare(heap[parent], candidate) <= 0) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = candidate;
    return;
  }
  if (compare(candidate, heap[0]) <= 0) return;
  let i = 0;
  while (i * 2 + 1 < heap.length) {
    let child = i * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0) child++;
    if (compare(candidate, heap[child]) <= 0) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = candidate;
}

export class FileSearchIndex {
  constructor(nodes, paths) {
    if (nodes instanceof ArrayBuffer) nodes = new Uint32Array(nodes);
    if (!(nodes instanceof Uint32Array) || nodes.length % 3)
      throw new Error('Invalid filename node triples');
    const bytes = paths instanceof Uint8Array ? paths : new Uint8Array(paths);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    this.files = nodes.length / 3;
    this.ids = new Uint32Array(this.files);
    this.paths = new Array(this.files);
    this.folded = new Array(this.files);
    this.basename = new Uint32Array(this.files);
    for (let i = 0; i < this.files; i++) {
      const id = nodes[i * 3],
        offset = nodes[i * 3 + 1],
        length = nodes[i * 3 + 2];
      if (!id || offset + length > bytes.length)
        throw new Error('Filename path range exceeds the transferred buffer');
      const path = decoder.decode(bytes.subarray(offset, offset + length)),
        folded = path.toLowerCase();
      this.ids[i] = id;
      this.paths[i] = path;
      this.folded[i] = folded;
      this.basename[i] = folded.lastIndexOf('/') + 1;
    }
  }

  async search(
    query,
    limit = 40,
    { shouldCancel = () => false, yieldControl = defaultYield, chunkSize = 32768 } = {},
  ) {
    const started = performance.now();
    if (typeof query !== 'string' || query.length > 1024 || query.includes('\0'))
      throw new Error('Filename query must be at most 1024 characters without NUL');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error('Filename limit must be 1–200');
    if (!Number.isInteger(chunkSize) || chunkSize < 1)
      throw new Error('Invalid filename scan chunk size');
    const needle = query.trim().toLowerCase(),
      heap = [];
    if (!needle)
      return { results: [], total: 0, complete: true, elapsed: performance.now() - started };
    let total = 0;
    for (let start = 0; start < this.files; start += chunkSize) {
      if (shouldCancel()) return null;
      const end = Math.min(this.files, start + chunkSize);
      for (let i = start; i < end; i++) {
        const path = this.folded[i],
          base = this.basename[i],
          match = path.indexOf(needle, base);
        let score = 0;
        if (match === base) score = path.length - base === needle.length ? 11000 : 10000;
        else if (match >= 0) score = 9000;
        else if (path.includes(needle)) score = 7000;
        if (!score) continue;
        total++;
        // Avoid allocating an object for the common, obviously lower-rank tail.
        if (heap.length === limit && score < heap[0].score) continue;
        retain(heap, { id: this.ids[i], path: this.paths[i], score }, limit);
      }
      if (end < this.files) await yieldControl();
    }
    if (shouldCancel()) return null;
    const results = heap
      .sort((a, b) => -compare(a, b))
      .map((hit) => ({
        ...hit,
        name: hit.path.slice(hit.path.lastIndexOf('/') + 1),
        kind: 'file',
        line: 0,
        column: 0,
      }));
    return { results, total, complete: true, elapsed: performance.now() - started };
  }
}

export function createFileSearchHandler({
  postMessage,
  yieldControl = defaultYield,
  chunkSize = 32768,
} = {}) {
  let index = null,
    generation = 0;
  return {
    async receive(message) {
      if (message?.type === 'init') {
        generation++;
        const started = performance.now();
        try {
          index = new FileSearchIndex(message.nodes, message.paths);
          postMessage({ type: 'ready', files: index.files, elapsed: performance.now() - started });
        } catch (error) {
          index = null;
          postMessage({ type: 'error', error: String(error?.message || error) });
        }
        return;
      }
      if (message?.type === 'cancel') {
        generation++;
        return;
      }
      if (message?.type !== 'search') return;
      const current = ++generation;
      try {
        if (!index) throw new Error('Filename index is not ready');
        const result = await index.search(message.query, message.limit ?? 40, {
          shouldCancel: () => current !== generation,
          yieldControl,
          chunkSize,
        });
        if (result && current === generation)
          postMessage({ type: 'results', token: message.token, ...result });
      } catch (error) {
        if (current === generation)
          postMessage({
            type: 'error',
            token: message.token,
            error: String(error?.message || error),
          });
      }
    },
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const handler = createFileSearchHandler({
    postMessage: (message) => globalThis.postMessage(message),
  });
  globalThis.addEventListener('message', (event) => {
    void handler.receive(event.data);
  });
}
