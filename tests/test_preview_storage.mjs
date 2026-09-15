import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStore } from '../src/index/client-store.mjs';
import { analyzeDocument, documentMetadata, buildSnapshot } from '../src/index/client-index.mjs';
import { importProject } from '../src/import/import-project.mjs';
import { LocalSource } from '../src/index/local-source.mjs';

const document = (id = 1) =>
  analyzeDocument({
    id,
    path: `file-${id}.txt`,
    revision: `revision-${id}`,
    text: `short\n${'long '.repeat(100)}\n\tend\n`,
  });

test('preview reads contain no source text, line offsets, wrapping table or syntax records', async () => {
  const store = await ClientStore.open('profiles-' + crypto.randomUUID());
  try {
    const doc = { ...document(), structure: { segments: [{ name: 'source' }] } };
    await store.putDocuments('a', [doc]);
    const source = await store.document('a', 1);
    assert.equal(source.rawProfile, undefined);
    assert.equal(source.displayProfile, undefined);
    assert.equal(source.text, doc.text);
    assert.deepEqual(source.lineOffsets, doc.lineOffsets);
    const profile = await store.profile('a', 1);
    assert.deepEqual(profile, {
      ...documentMetadata(doc),
      rawProfile: doc.rawProfile,
      displayProfile: doc.displayProfile,
    });
    const page = await new LocalSource(store, 'a').request('document', { id: 1, count: 10 });
    assert.equal(page.sourceLines.join('\n') + '\n', doc.text);
  } finally {
    store.close();
  }
});

test('import builds byte-identical previews without rereading full source documents', async () => {
  const store = await ClientStore.open('profile-pipeline-' + crypto.randomUUID());
  const docs = [document(1), document(2)];
  let sourceReads = 0;
  const original = store.document.bind(store);
  store.document = (...args) => {
    sourceReads++;
    return original(...args);
  };
  try {
    const result = await importProject(
      store,
      { projectId: 'a', input: 'example/repo' },
      {
        resolve: async () => ({ fullName: 'example/repo', commit: 'immutable' }),
        list: async () => docs,
        download: async (_repo, files, { onFile }) => {
          for (const doc of files) await onFile(doc);
          return { skipped: 0, bytes: docs.reduce((n, d) => n + d.bytes, 0) };
        },
      },
    );
    assert.equal(sourceReads, 0, 'preview generation must not deserialize source');
    const actual = await store.snapshot('a');
    const expected = await buildSnapshot(
      docs.map(documentMetadata),
      result.repo,
      async (id) => docs[id - 1],
    );
    for (const key of ['nodes', 'paths', 'previews'])
      assert.deepEqual(new Uint8Array(actual[key]), new Uint8Array(expected[key]));
    assert.equal(
      await store.profile('a', 1),
      undefined,
      'completed imports release temporary profiles',
    );
    assert.equal((await store.document('a', 1)).text, docs[0].text);
  } finally {
    store.close();
  }
});

test('cancellation and deletion reclaim profiles without touching another project', async () => {
  const store = await ClientStore.open('profile-cleanup-' + crypto.randomUUID());
  try {
    await store.putDocuments('a', [document()]);
    await store.putDocuments('b', [document()]);
    await store.clearDocuments('a');
    assert.equal(await store.profile('a', 1), undefined);
    assert.ok(await store.profile('b', 1));
    await store.deleteProject('b');
    assert.equal(await store.profile('b', 1), undefined);
  } finally {
    store.close();
  }
});

test('failed batches atomically roll back both documents and profiles', async () => {
  const store = await ClientStore.open('profile-rollback-' + crypto.randomUUID());
  try {
    await assert.rejects(store.putDocuments('a', [document(), { ...document(2), id: undefined }]));
    assert.equal(await store.document('a', 1), undefined);
    assert.equal(await store.profile('a', 1), undefined);
  } finally {
    store.close();
  }
});

test('schema upgrade preserves version-one source and ready snapshots', async () => {
  const name = 'profile-upgrade-' + crypto.randomUUID();
  const legacy = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('documents', { keyPath: ['project', 'id'] });
      db.createObjectStore('snapshots');
      db.createObjectStore('indexes');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const doc = document();
  await new Promise((resolve, reject) => {
    const tx = legacy.transaction(['projects', 'documents', 'snapshots', 'indexes'], 'readwrite');
    tx.objectStore('projects').put({ id: 'a', state: 'ready' });
    tx.objectStore('documents').put({ project: 'a', id: 1, value: doc });
    tx.objectStore('snapshots').put({ manifest: { stats: { files: 1 } } }, 'a');
    tx.objectStore('indexes').put({ metas: [documentMetadata(doc)], symbols: [] }, 'a');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  legacy.close();
  const store = await ClientStore.open(name);
  try {
    assert.ok(store.db.objectStoreNames.contains('profiles'));
    assert.deepEqual(await store.document('a', 1), doc);
    assert.equal((await store.snapshot('a')).manifest.stats.files, 1);
    assert.equal((await store.index('a')).metas.length, 1);
  } finally {
    store.close();
  }
});
