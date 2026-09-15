import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStore } from '../src/index/client-store.mjs';
import { importProject, importFolderFiles, localPath } from '../src/import/import-project.mjs';
import { LocalSource } from '../src/index/local-source.mjs';
import { searchSymbols, searchText } from '../src/index/client-search.mjs';

const repo = { name: 'sample', fullName: 'sample/repo', commit: 'a'.repeat(40) };
function network(files) {
  return {
    resolve: async () => repo,
    list: async () => files,
    download: async (_repo, entries, { onFile, signal }) => {
      for (const file of entries) {
        signal?.throwIfAborted();
        await onFile(file);
      }
      return {
        downloaded: entries.length,
        skipped: 2,
        bytes: entries.reduce((n, f) => n + f.bytes, 0),
        skipReasons: { binary: 2 },
      };
    },
  };
}
const fixture = {
  path: 'src/main.js',
  text: 'export function greet(name) {\n  return `Hello ${name}`;\n}\n',
  revision: 'b'.repeat(40),
  bytes: 56,
};
test('real browser pipeline persists source, WASM symbols and compatible map; cached commit is reused', async () => {
  const store = await ClientStore.open('pipeline-' + crypto.randomUUID());
  const result = await importProject(
    store,
    { projectId: 'first', input: 'sample/repo' },
    network([fixture]),
  );
  assert.equal(result.stats.files, 1);
  assert.equal(result.stats.skipped, 2);
  assert.equal((await store.project('first')).state, 'ready');
  const index = await store.index('first'),
    hit = searchSymbols(index.symbols, 'greet').results[0];
  assert.equal(hit.path, fixture.path);
  assert.equal(hit.line, 0);
  const source = new LocalSource(store, 'first');
  const page = await source.request('document', { id: hit.id, count: 80 });
  assert.equal(page.sourceLines.join('\n') + '\n', fixture.text);
  assert.equal(
    (await source.request('address', { id: hit.id, line: hit.line, column: hit.column }))
      .displayLine,
    0,
  );
  const selection = await source.request('selection', {
    id: hit.id,
    line: hit.line,
    column: hit.column,
    endLine: hit.endLine,
    endColumn: hit.endColumn,
  });
  assert.equal(selection.revision, fixture.revision);
  assert.equal(selection.source.end.column - selection.source.start.column, 'greet'.length);
  assert.equal(selection.display.start.line, 0);
  assert.equal(selection.address.displayColumn, hit.column);
  assert.equal(
    (await searchText(index.metas, (id) => store.document('first', id), 'Hello')).results[0].line,
    1,
  );
  const again = await importProject(
    store,
    { projectId: 'second', input: 'sample/repo' },
    {
      ...network([]),
      download: () => {
        throw Error('must not redownload cached commit');
      },
    },
  );
  assert.equal(again.projectId, 'first');
  assert.equal(await store.project('second'), undefined);
  store.close();
});
test('partial download failure removes source and never publishes a map', async () => {
  const store = await ClientStore.open('pipeline-' + crypto.randomUUID());
  await assert.rejects(
    importProject(
      store,
      { projectId: 'failed', input: 'sample/repo' },
      {
        ...network([fixture]),
        download: async (_repo, _entries, { onFile }) => {
          await onFile(fixture);
          throw Error('HTTP 503');
        },
      },
    ),
    /HTTP 503/,
  );
  assert.equal((await store.project('failed')).state, 'failed');
  assert.equal(await store.document('failed', 1), undefined);
  await assert.rejects(store.snapshot('failed'), /ready/);
  store.close();
});
test('cancellation after source processing clears partial records', async () => {
  const store = await ClientStore.open('pipeline-' + crypto.randomUUID()),
    controller = new AbortController();
  await assert.rejects(
    importProject(
      store,
      { projectId: 'cancelled', input: 'sample/repo' },
      {
        ...network([fixture]),
        signal: controller.signal,
        onProgress: (p) => {
          if (p.stage === 'indexing') controller.abort();
        },
      },
    ),
    (e) => e.name === 'AbortError',
  );
  assert.equal((await store.project('cancelled')).state, 'cancelled');
  assert.equal(await store.document('cancelled', 1), undefined);
  store.close();
});
test('folder import preserves BOM, excludes ignored paths and rejects escaping/duplicate paths', async () => {
  const file = (path, text) =>
    Object.assign(new File([text], path.split('/').pop()), { webkitRelativePath: path });
  assert.throws(() => localPath(file('root/../escape', 'x')), /Invalid/);
  const files = [
      file('root/main.js', '\ufefflet x=1;\r\n'),
      file('root/node_modules/x.js', 'skip'),
    ],
    docs = [];
  const report = await importFolderFiles(files, { onFile: async (doc) => docs.push(doc) });
  assert.equal(docs[0].text, '\ufefflet x=1;\r\n');
  assert.equal(report.skipped, 1);
  assert.equal(docs[0].revision.length, 64);
  await assert.rejects(
    importFolderFiles([files[0], files[0]], { onFile: async () => {} }),
    /Duplicate/,
  );
});
test('storage preflight does not reject downloadable source because of skipped binary bytes', async () => {
  const store = await ClientStore.open('pipeline-' + crypto.randomUUID());
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: { estimate: async () => ({ quota: 100 * 1048576, usage: 0 }) },
    configurable: true,
  });
  try {
    const result = await importProject(
      store,
      { projectId: 'binary', input: 'sample/repo' },
      {
        ...network([fixture]),
        list: async () => [{ path: 'archive.zip', size: 50 * 1048576 }, fixture],
        download: async (_r, _e, { onFile }) => {
          await onFile(fixture);
          return { downloaded: 1, skipped: 1, bytes: fixture.bytes };
        },
      },
    );
    assert.equal(result.stats.files, 1);
  } finally {
    delete globalThis.navigator.storage;
    store.close();
  }
});
test('project symbol retention has a global bound and reports omitted symbols', async () => {
  const store = await ClientStore.open('pipeline-' + crypto.randomUUID());
  const result = await importProject(
    store,
    { projectId: 'limited', input: 'sample/repo' },
    {
      ...network([fixture]),
      maxSymbols: 1,
      extract: async (doc) => ({
        parser: 'fixture',
        state: 'parsed',
        complete: true,
        segments: [],
        symbols: [
          { id: doc.id, name: 'one' },
          { id: doc.id, name: 'two' },
        ],
      }),
    },
  );
  assert.equal((await store.index('limited')).symbols.length, 1);
  assert.equal(result.coverage.symbolsOmitted, 1);
  assert.equal(result.coverage.symbolIndexLimited, true);
  store.close();
});

test('ZIP pipeline builds searchable source and map without GitHub requests', async () => {
  const { ZipWriter, Uint8ArrayWriter, TextReader } =
    await import('@zip.js/zip.js/index-native.js');
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await zip.add('sample-main/src/main.js', new TextReader(fixture.text));
  const store = await ClientStore.open('zip-pipeline-' + crypto.randomUUID());
  try {
    const result = await importProject(
      store,
      { projectId: 'zip', input: 'sample-main', archive: new Blob([await zip.close()]) },
      {
        resolve: () => {
          throw Error('ZIP must not contact GitHub');
        },
      },
    );
    assert.equal(result.repo.source, 'zip');
    assert.equal(result.stats.files, 1);
    assert.equal((await store.project('zip')).state, 'ready');
    const index = await store.index('zip'),
      hit = searchSymbols(index.symbols, 'greet').results[0];
    assert.equal(hit.path, 'src/main.js');
    assert.equal(
      (await searchText(index.metas, (id) => store.document('zip', id), 'Hello')).results[0].line,
      1,
    );
    const source = new LocalSource(store, 'zip');
    assert.equal(
      (await source.request('document', { id: hit.id, count: 80 })).sourceLines.join('\n') + '\n',
      fixture.text,
    );
    assert.ok((await store.snapshot('zip')).nodes.byteLength > 0);
  } finally {
    store.close();
  }
});
test('ZIP cancellation removes already indexed source without publishing a partial map', async () => {
  const { ZipWriter, Uint8ArrayWriter, TextReader } =
    await import('@zip.js/zip.js/index-native.js');
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const path of ['a.js', 'b.js']) await zip.add(path, new TextReader(fixture.text));
  const store = await ClientStore.open('zip-cancel-' + crypto.randomUUID()),
    controller = new AbortController();
  try {
    await assert.rejects(
      importProject(
        store,
        { projectId: 'zip', input: 'sample', archive: new Blob([await zip.close()]) },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.stage === 'indexing') controller.abort();
          },
        },
      ),
      (e) => e.name === 'AbortError',
    );
    assert.equal((await store.project('zip')).state, 'cancelled');
    assert.equal(await store.document('zip', 1), undefined);
    await assert.rejects(store.snapshot('zip'), /ready/);
  } finally {
    store.close();
  }
});
