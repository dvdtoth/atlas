import { importFolderFiles } from './local-files.mjs';
import { resolveRepository, listRepository, downloadRepository } from './github-import.mjs';
import { documentMetadata, buildSnapshot } from '../index/client-index.mjs';
import { extractSymbols } from '../index/client-search.mjs';
import { indexDocument } from './index-document.mjs';
import { OrderedImportQueue } from './import-queue.mjs';

export async function importProject(
  store,
  { projectId, input, ref = '', files = null, archive = null },
  {
    signal,
    onProgress = () => {},
    resolve = resolveRepository,
    list = listRepository,
    download = downloadRepository,
    extract = extractSymbols,
    indexer = null,
    maxSymbols = 500_000,
    maxSymbolBytes = 96 * 1048576,
  } = {},
) {
  const check = () => signal?.throwIfAborted();
  const started = performance.now();
  let repo, queue;
  const source = archive ? 'zip' : files ? 'folder' : 'github',
    local = source !== 'github';
  await store.createProject({ id: projectId, fullName: input || 'Local folder', source });
  try {
    check();
    repo = local
      ? { name: input, fullName: input, commit: 'local-' + projectId, source }
      : await resolve(input, { ref, signal, onProgress });
    repo.projectId = projectId;
    if (!local) {
      const cached = (await store.projects()).find(
        (p) => p.state === 'ready' && p.fullName === repo.fullName && p.commit === repo.commit,
      );
      if (cached) {
        await store.deleteProject(projectId);
        return { projectId: cached.id, cached: true, repo, stats: cached.stats };
      }
    }
    await store.updateProject(projectId, { fullName: repo.fullName, commit: repo.commit, repo });
    const metas = [],
      symbols = [],
      coverage = {
        parsed: 0,
        partial: 0,
        unsupported: 0,
        limited: 0,
        unavailable: 0,
        symbolsIndexed: 0,
        symbolsOmitted: 0,
        symbolIndexLimited: false,
      };
    let symbolBytes = 0,
      nextID = 0,
      batch = [],
      batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      check();
      const docs = batch;
      batch = [];
      batchBytes = 0;
      await store.putDocuments(projectId, docs);
      check();
    };
    queue = new OrderedImportQueue({
      concurrency: indexer?.size || 1,
      maxPending: (indexer?.size || 1) * 4,
      signal,
      process: (file, slot) =>
        indexer ? indexer.process(file, slot) : indexDocument(file, { extract, signal }),
      consume: async ({ doc, symbols: found, state }) => {
        check();
        coverage[state]++;
        for (const symbol of found) {
          const size =
            384 +
            Object.values(symbol).reduce(
              (n, v) => n + (typeof v === 'string' ? v.length * 2 : 0),
              0,
            );
          if (symbols.length >= maxSymbols || symbolBytes + size > maxSymbolBytes) {
            coverage.symbolsOmitted++;
            coverage.symbolIndexLimited = true;
          } else {
            symbols.push(symbol);
            symbolBytes += size;
            coverage.symbolsIndexed++;
          }
        }
        const buffers = new Set(
          [doc.lineOffsets, doc.rawProfile, doc.displayProfile, doc.wraps]
            .filter(Boolean)
            .map((v) => v.buffer),
        );
        const cost =
          doc.text.length * 2 +
          [...buffers].reduce((n, b) => n + b.byteLength, 0) +
          (doc.structure.segments?.length || 0) * 128 +
          4096;
        if (batchBytes + cost > 8 * 1024 ** 2) await flush();
        batch.push(doc);
        batchBytes += cost;
        metas.push(documentMetadata(doc));
        if (batch.length >= 32 || batchBytes >= 8 * 1024 ** 2) await flush();
        onProgress({
          stage: 'indexing',
          completed: metas.length,
          symbols: symbols.length,
          workers: indexer?.size || 1,
          message: `Indexed ${metas.length.toLocaleString()} files · ${indexer?.size || 1} indexing workers`,
        });
      },
    });
    // Await admission, not completion: extraction overlaps a bounded pool of parsers.
    const onFile = (file) => queue.submit({ ...file, id: ++nextID });
    let report;
    if (archive) {
      const { importZipFiles } = await import('./zip-import.mjs');
      report = await importZipFiles(archive, { signal, onProgress, onFile });
    } else if (files) report = await importFolderFiles(files, { signal, onProgress, onFile });
    else {
      const entries = await list(repo, { signal, onProgress });
      check();
      report = await download(repo, entries, { signal, onProgress, onFile });
    }
    await queue.finish();
    indexer?.close();
    await flush();
    check();
    if (!metas.length) throw Error('No supported text files were found in this repository.');
    onProgress({
      stage: 'layout',
      message: 'Packing folders and generating source previews…',
      completed: 0,
      total: metas.length,
    });
    const snapshot = await buildSnapshot(
      metas,
      repo,
      async (id) => {
        check();
        return store.profile(projectId, id);
      },
      (p) => onProgress({ ...p, stage: p.phase || 'layout' }),
    );
    check();
    snapshot.manifest.stats = {
      ...snapshot.manifest.stats,
      skipped: report.skipped,
      bytes: report.bytes,
    };
    snapshot.manifest.coverage = coverage;
    snapshot.manifest.skipReasons = report.skipReasons || {};
    onProgress({ stage: 'saving', message: 'Saving the completed map on this device…' });
    await store.publish(projectId, snapshot, metas, symbols, coverage);
    return {
      projectId,
      repo,
      stats: snapshot.manifest.stats,
      coverage,
      seconds: (performance.now() - started) / 1000,
    };
  } catch (error) {
    queue?.cancel(error);
    indexer?.close(error);
    await queue?.finish().catch(() => {});
    await store
      .updateProject(projectId, {
        state: signal?.aborted ? 'cancelled' : 'failed',
        error: String(error.message || error),
      })
      .catch(() => {});
    await store.clearDocuments(projectId).catch(() => {});
    throw error;
  } finally {
    indexer?.close();
  }
}

export { importFolderFiles, localPath } from './local-files.mjs';
