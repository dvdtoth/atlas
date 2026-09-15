import test from 'node:test';
import assert from 'node:assert/strict';
let api;
try {
  api = await import('../src/index/file-search-worker.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}
function fixture(paths, ids = paths.map((_, i) => i + 1)) {
  const encoder = new TextEncoder(),
    encoded = paths.map((p) => encoder.encode(p)),
    bytes = new Uint8Array(encoded.reduce((n, p) => n + p.length, 0)),
    nodes = new Uint32Array(paths.length * 3);
  let offset = 0;
  for (let i = 0; i < paths.length; i++) {
    nodes.set([ids[i], offset, encoded[i].length], i * 3);
    bytes.set(encoded[i], offset);
    offset += encoded[i].length;
  }
  return { nodes, paths: bytes.buffer };
}
function index(paths, ids) {
  assert.ok(api, 'Filename search worker must be implemented');
  const f = fixture(paths, ids);
  return new api.FileSearchIndex(f.nodes, f.paths);
}
test('exact basename, prefix, basename substring and path substring rank in order', async () => {
  const x = index(['foo.js/other.cc', 'src/my_foo.js_test.cc', 'src/foo.jsx', 'nested/foo.js']);
  const r = await x.search('foo.js', 40);
  assert.deepEqual(
    r.results.map((v) => v.path),
    ['nested/foo.js', 'src/foo.jsx', 'src/my_foo.js_test.cc', 'foo.js/other.cc'],
  );
  assert.deepEqual(
    r.results.map((v) => Math.floor(v.score / 1000)),
    [11, 10, 9, 7],
  );
  assert.equal(r.total, 4);
  assert.equal(r.complete, true);
  assert.equal(r.results[0].name, 'foo.js');
  assert.equal(r.results[0].kind, 'file');
  assert.equal(r.results[0].line, 0);
});
test('search is case insensitive and preserves original UTF-8 paths and IDs', async () => {
  const x = index(['src/École/Widget.JS', 'other/widget.js'], [255236, 9]);
  const r = await x.search('éCOLE/WIDGET', 40);
  assert.equal(r.results[0].id, 255236);
  assert.equal(r.results[0].path, 'src/École/Widget.JS');
  assert.equal(r.results[0].name, 'Widget.JS');
  assert.equal(r.results[0].column, 0);
});
test('the complete path index finds late exact names beyond early matching files', async () => {
  const paths = Array.from(
    { length: 100000 },
    (_, i) => `early/${i}/idb-load-docs-shared.js.fixture`,
  );
  paths.push('third_party/blink/web_tests/storage/indexeddb/resources/idb-load-docs-shared.js');
  const x = index(
    paths,
    paths.map((_, i) => (i === 100000 ? 255236 : i + 1)),
  );
  const r = await x.search('idb-load-docs-shared.js', 3);
  assert.equal(r.results[0].id, 255236);
  assert.equal(r.total, 100001);
  assert.equal(r.results.length, 3);
});
test('ties are deterministic and limits remain bounded', async () => {
  const x = index(['z/alpha.js', 'a/alpha.js', 'm/alpha.js']);
  const r = await x.search('ALPHA.JS', 2);
  assert.deepEqual(
    r.results.map((x) => x.path),
    ['a/alpha.js', 'm/alpha.js'],
  );
  assert.equal(r.total, 3);
  assert.deepEqual((await x.search('  ', 40)).results, []);
  await assert.rejects(x.search('alpha', 0), /limit/);
  await assert.rejects(x.search('a'.repeat(1025), 40), /1024/);
});
test('chunked search stops promptly after cancellation', async () => {
  const x = index(Array.from({ length: 80 }, (_, i) => `${i}/hello.js`));
  let canceled = false,
    yields = 0;
  const result = await x.search('hello', 40, {
    chunkSize: 8,
    shouldCancel: () => canceled,
    yieldControl: async () => {
      yields++;
      canceled = true;
    },
  });
  assert.equal(result, null);
  assert.equal(yields, 1);
});
test('worker protocol returns readiness and suppresses stale query tokens', async () => {
  assert.ok(api, 'Filename search worker must be implemented');
  const output = [];
  let release, started;
  const pause = new Promise((resolve) => (started = resolve));
  const handler = api.createFileSearchHandler({
    postMessage: (r) => output.push(r),
    chunkSize: 2,
    yieldControl: () => {
      started();
      return new Promise((resolve) => (release = resolve));
    },
  });
  await handler.receive({ type: 'init', ...fixture(['a/a.js', 'b/a.js', 'c/a.js']) });
  assert.equal(output[0].type, 'ready');
  assert.equal(output[0].files, 3);
  const old = handler.receive({ type: 'search', token: 1, query: 'a.js', limit: 40 });
  await pause;
  const newer = handler.receive({ type: 'search', token: 2, query: '', limit: 40 });
  await newer;
  release();
  await old;
  assert.deepEqual(
    output.filter((r) => r.type === 'results').map((r) => r.token),
    [2],
  );
});
