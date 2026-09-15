import { ClientStore } from '../index/client-store.mjs';
import { importProject } from './import-project.mjs';
import { LocalSource } from '../index/local-source.mjs';
import { searchSymbols, searchText } from '../index/client-search.mjs';
import { ImportWorkers } from './import-workers.mjs';
import { serveWorker } from '../shared/worker-rpc.mjs';
import { createImportProgressReporter } from './import-progress.mjs';
const storePromise = ClientStore.open();
let source = null,
  index = null,
  importing = false;
serveWorker(async (method, args, options) => {
  if (method === 'import')
    options.onProgress({ stage: 'storage', message: 'Opening browser storage…' });
  const store = await storePromise;
  if (method === 'import') {
    if (importing) throw Error('Another import is already running in this tab.');
    importing = true;
    const indexer = new ImportWorkers();
    let lastProgress = -Infinity,
      lastStage = '';
    const onProgress = createImportProgressReporter((value) => {
      const now = performance.now();
      if (
        now - lastProgress >= 100 ||
        (['layout', 'previews', 'saving'].includes(value.stage) && value.stage !== lastStage)
      ) {
        lastProgress = now;
        lastStage = value.stage;
        options.onProgress(value);
      }
    });
    try {
      return await importProject(store, args, { ...options, indexer, onProgress });
    } finally {
      indexer.close();
      importing = false;
    }
  }
  if (method === 'open') {
    const snapshot = await store.snapshot(args.projectId);
    index = await store.index(args.projectId);
    source = new LocalSource(store, args.projectId);
    return snapshot;
  }
  if (!source) throw Error('Open a repository first.');
  if (['document', 'address', 'selection', 'segments'].includes(method))
    return source.request(method, args);
  if (method === 'search-status') return index.coverage;
  if (method === 'suggest' || method === 'search') {
    const q = String(args.q || '').trim();
    if (!q || q.length > 512) return { results: [], total: 0, status: 'complete' };
    if (args.mode === 'text')
      return searchText(index.metas, (id) => store.document(source.project, id), q, {
        limit: 40,
        signal: options.signal,
      });
    const report = searchSymbols(index.symbols, q, 40);
    return {
      ...report,
      status: index.coverage.symbolIndexLimited ? 'partial' : report.status,
      coverage: index.coverage,
    };
  }
  throw Error('Unknown local operation');
});
