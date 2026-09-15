import test from 'node:test';
import assert from 'node:assert/strict';
import { importFolderFiles } from '../src/import/local-files.mjs';
const tick = () => new Promise(setImmediate);
function fakeFiles(count, read) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${i}.txt`,
    size: 4,
    arrayBuffer: () => read(i),
  }));
}
test('local reads overlap, but admission keeps path order and a bounded read-ahead window', async () => {
  const started = [],
    release = new Map(),
    seen = [];
  let admit;
  const files = fakeFiles(9, (i) => {
    started.push(i);
    return new Promise((r) => release.set(i, () => r(new TextEncoder().encode(`${i}abc`).buffer)));
  });
  const pending = importFolderFiles(files, {
    readConcurrency: 4,
    onFile: async (doc) => {
      seen.push(doc.path);
      if (seen.length === 1)
        await new Promise((r) => {
          admit = r;
        });
    },
  });
  for (let i = 0; i < 10 && started.length < 4; i++) await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  for (const i of [3, 2, 1, 0]) release.get(i)();
  for (let i = 0; i < 10 && !admit; i++) await tick();
  assert.deepEqual(seen, ['0.txt']);
  assert.equal(started.length, 4);
  admit();
  while (started.length < 9) {
    await tick();
    for (const [i, done] of release) {
      done();
      release.delete(i);
    }
  }
  for (const done of release.values()) done();
  const result = await pending;
  assert.deepEqual(
    seen,
    files.map((f) => f.name),
  );
  assert.equal(result.bytes, 36);
});
test('read-ahead credit also bounds source bytes, independent of read count', async () => {
  let started = 0,
    release;
  const files = fakeFiles(3, async () => {
    started++;
    return new TextEncoder().encode('abcd').buffer;
  });
  const pending = importFolderFiles(files, {
    readConcurrency: 4,
    maxReadBytes: 4,
    onFile: async () => {
      if (started === 1)
        await new Promise((r) => {
          release = r;
        });
    },
  });
  for (let i = 0; i < 10 && !release; i++) await tick();
  assert.equal(started, 1);
  release();
  await pending;
  assert.equal(started, 3);
});
test('read failure prevents pending source admissions and cancellation retains AbortError', async () => {
  let reads = 0,
    seen = 0;
  const controller = new AbortController();
  await assert.rejects(
    importFolderFiles(
      fakeFiles(8, async (i) => {
        reads++;
        if (i === 1) throw Error('disk failure');
        return new TextEncoder().encode('abcd').buffer;
      }),
      {
        onFile: async () => {
          seen++;
        },
      },
    ),
    /disk failure/,
  );
  const before = seen;
  await tick();
  assert.equal(seen, before);
  assert.ok(reads <= 4);
  await assert.rejects(
    importFolderFiles(
      fakeFiles(8, async () => new TextEncoder().encode('abcd').buffer),
      { signal: controller.signal, onFile: async () => controller.abort() },
    ),
    (e) => e.name === 'AbortError',
  );
});

test('local read-ahead validates declared and actual source sizes before admission', async () => {
  const onFile = () => assert.fail('invalid source must not be admitted');
  await assert.rejects(
    importFolderFiles(
      [{ name: 'bad.txt', size: 1, arrayBuffer: async () => new Uint8Array(2).buffer }],
      { onFile },
    ),
    /changed size/,
  );
  for (const size of [-1, NaN, Infinity])
    await assert.rejects(
      importFolderFiles([{ name: 'bad.txt', size }], { onFile }),
      /Invalid local file size/,
    );
  let bytes = 0;
  await assert.rejects(
    importFolderFiles(
      fakeFiles(2, async () => {
        bytes += 4;
        return new TextEncoder().encode('abcd').buffer;
      }),
      { maxBytes: 5, onFile: async () => {} },
    ),
    /budget/,
  );
  assert.ok(bytes <= 4);
});
