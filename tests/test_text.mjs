import test from 'node:test';
import assert from 'node:assert/strict';

const layout = await import('../src/render/text-layout.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const worker = await import('../src/render/text-worker.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('tabs retain original four-column stops when a tile clips the row', () => {
  assert.equal(typeof layout.layoutLine, 'function');
  const { runs, columns } = layout.layoutLine('a\tb\tc', { column: 3, count: 6 });
  assert.equal(columns, 9);
  assert.deepEqual(
    runs.map(({ text, column }) => [text, column]),
    [
      ['b', 4],
      ['c', 8],
    ],
  );
  assert.deepEqual(
    layout.layoutLine('\tZ', { origin: 6 }).runs.map(({ text, column }) => [text, column]),
    [['Z', 2]],
  );
});

test('Unicode clusters stay intact and occupy the conservative scalar budget', () => {
  assert.equal(typeof layout.layoutLine, 'function');
  const text = 'a' + 'e\u0301' + '👩‍💻' + '界' + 'z';
  const { runs, columns } = layout.layoutLine(text, { column: 3, count: 15 });
  assert.equal(columns, 18);
  assert.deepEqual(
    runs.map(({ text, column, cells }) => [text, column, cells]),
    [
      ['e\u0301', 1, 4],
      ['👩‍💻', 5, 9],
      ['界', 14, 3],
      ['z', 17, 1],
    ],
  );
});

test('blank and whitespace source remains blank without placeholder glyphs', () => {
  assert.equal(typeof layout.layoutLine, 'function');
  for (const line of ['', '   ', '\t \t']) assert.deepEqual(layout.layoutLine(line).runs, []);
});

test('lexical string tokens contain comment delimiters without turning into comments', () => {
  assert.equal(typeof layout.lexLine, 'function');
  const line = 'const url = "https://a/#b"; // return 23';
  const { tokens } = layout.lexLine(line, { path: 'file.js' });
  assert.deepEqual(
    tokens.filter((t) => t.kind !== 'plain').map((t) => [line.slice(t.start, t.end), t.kind]),
    [
      ['const', 'keyword'],
      ['"https://a/#b"', 'string'],
      ['// return 23', 'comment'],
    ],
  );
});

test('block comments and multiline string state continue across adjacent rows', () => {
  assert.equal(typeof layout.lexLine, 'function');
  const first = layout.lexLine('const a = /* block', { path: 'file.js' });
  const second = layout.lexLine('still */ 42;', { path: 'file.js', state: first.state });
  assert.deepEqual(
    second.tokens
      .filter((t) => t.kind !== 'plain')
      .map((t) => ['still */ 42;'.slice(t.start, t.end), t.kind]),
    [
      ['still */', 'comment'],
      ['42', 'number'],
    ],
  );
  const template = layout.lexLine('const x = `/* text', { path: 'file.js' });
  const continued = layout.lexLine('still // text`;', { path: 'file.js', state: template.state });
  assert.equal(continued.tokens[0].kind, 'string');
  assert.equal(continued.state.mode, 'normal');
});

test('hash comments follow file language and do not swallow JavaScript private fields', () => {
  assert.equal(typeof layout.lexLine, 'function');
  assert.equal(layout.lexLine('x = 3 # note', { path: 'script.py' }).tokens.at(-1).kind, 'comment');
  assert.ok(
    !layout.lexLine('#field = 3', { path: 'code.js' }).tokens.some((t) => t.kind === 'comment'),
  );
});

test('display continuation keeps a line comment until the original source newline', () => {
  const first = layout.lexLine('// a wrapped', { continued: true, path: 'a.js' });
  const second = layout.lexLine('comment with const 2', { state: first.state, path: 'a.js' });
  assert.deepEqual(second.tokens, [{ start: 0, end: 20, kind: 'comment' }]);
  assert.equal(second.state.mode, 'normal');
  const third = layout.lexLine('const b = 2', { state: second.state, path: 'a.js' });
  assert.equal(third.tokens[0].kind, 'keyword');
});

test('cached pages are bounded and used only with an explicit matching revision', async () => {
  assert.equal(typeof worker.SourcePageCache, 'function');
  let requests = 0;
  const cache = new worker.SourcePageCache({
    maxPages: 1,
    maxBytes: 4096,
    fetch: async (url) => {
      requests++;
      const start = Number(new URL(url, 'http://localhost').searchParams.get('start'));
      return new Response(
        JSON.stringify({
          id: 7,
          path: 'a.js',
          revision: 'r1',
          totalLines: 64,
          start,
          sourceLines: ['const a = 1;'],
          lineMap: [start],
          columnMap: [0],
        }),
      );
    },
  });
  const request = { id: 7, display: true, start: 0, revision: 'r1' };
  await cache.get(request);
  await cache.get(request);
  assert.equal(requests, 1);
  await cache.get({ ...request, start: 32 });
  await cache.get(request);
  assert.equal(requests, 3);
  await cache.get({ ...request, revision: undefined });
  await cache.get({ ...request, revision: undefined });
  assert.equal(requests, 5);
});

test('a changed server revision is returned and cannot contaminate the requested revision cache', async () => {
  assert.equal(typeof worker.SourcePageCache, 'function');
  let requests = 0;
  const cache = new worker.SourcePageCache({
    fetch: async () => {
      requests++;
      return new Response(
        JSON.stringify({
          id: 7,
          path: 'a.js',
          revision: 'r2',
          totalLines: 1,
          start: 0,
          sourceLines: ['new'],
          lineMap: [0],
          columnMap: [0],
        }),
      );
    },
  });
  const request = { id: 7, display: false, start: 0, revision: 'r1' };
  assert.equal((await cache.get(request)).revision, 'r2');
  assert.equal((await cache.get(request)).revision, 'r2');
  assert.equal(requests, 2);
  await cache.get({ ...request, revision: 'r2' });
  assert.equal(requests, 2);
});

test('canceling one shared-page subscriber does not abort another subscriber', async () => {
  let finishFetch,
    networkSignal,
    requests = 0;
  const cache = new worker.SourcePageCache({
    fetch: async (url, { signal }) => {
      requests++;
      networkSignal = signal;
      return await new Promise((resolve) => {
        finishFetch = () =>
          resolve(
            new Response(
              JSON.stringify({
                id: 7,
                path: 'a.js',
                revision: 'r1',
                totalLines: 1,
                start: 0,
                sourceLines: [''],
                lineMap: [0],
                columnMap: [0],
              }),
            ),
          );
      });
    },
  });
  const first = new AbortController(),
    second = new AbortController();
  const request = { id: 7, display: false, start: 0, revision: 'r1' };
  const pendingFirst = cache.get(request, first.signal);
  const pendingSecond = cache.get(request, second.signal);
  first.abort();
  await assert.rejects(pendingFirst, { name: 'AbortError' });
  assert.equal(networkSignal.aborted, false);
  finishFetch();
  assert.equal((await pendingSecond).revision, 'r1');
  assert.equal(requests, 1);
});

test('an oversized page is returned but not retained beyond the byte budget', async () => {
  let requests = 0;
  const cache = new worker.SourcePageCache({
    maxBytes: 1024,
    fetch: async () => {
      requests++;
      return new Response(
        JSON.stringify({
          id: 7,
          path: 'a.js',
          revision: 'r1',
          totalLines: 1,
          start: 0,
          sourceLines: ['a'.repeat(1024)],
          lineMap: [0],
          columnMap: [0],
        }),
      );
    },
  });
  const request = { id: 7, display: false, start: 0, revision: 'r1' };
  await cache.get(request);
  await cache.get(request);
  assert.equal(requests, 2);
  assert.equal(cache.bytes, 0);
});

test('source maps with an incorrect row count are rejected before rasterization', async () => {
  const cache = new worker.SourcePageCache({
    fetch: async () =>
      new Response(
        JSON.stringify({
          id: 7,
          revision: 'r1',
          start: 0,
          sourceLines: ['a'],
          lineMap: [],
          columnMap: [0],
        }),
      ),
  });
  await assert.rejects(cache.get({ id: 7, start: 0, display: false }), /Invalid source page/);
});

test('raster output fills every pixel opaquely while empty source rows draw no glyphs', async () => {
  const previous = globalThis.OffscreenCanvas;
  const draws = [],
    fills = [];
  const bitmap = { close() {} };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext(kind, options) {
      assert.equal(kind, '2d');
      assert.equal(options.alpha, false);
      return {
        fillRect(...bounds) {
          fills.push({ color: this.fillStyle, bounds });
        },
        fillText(text) {
          draws.push(text);
        },
        scale() {},
        save() {},
        restore() {},
        translate() {},
        measureText() {
          return { width: 9 };
        },
      };
    }
    transferToImageBitmap() {
      return bitmap;
    }
  };
  try {
    const pages = new worker.SourcePageCache({
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: 7,
            path: 'a.js',
            revision: 'r1',
            totalLines: 3,
            start: 0,
            sourceLines: ['a\tb', '', '  '],
            lineMap: [0, 1, 2],
            columnMap: [0, 0, 0],
          }),
        ),
    });
    const result = await worker.renderTile(
      { key: 'raster', id: 7, start: 0, column: 0, scale: 2, display: true, background: '#102030' },
      new AbortController().signal,
      pages,
    );
    assert.deepEqual([result.width, result.height], [2304, 1280]);
    assert.deepEqual(fills, [{ color: '#102030', bounds: [0, 0, 2304, 1280] }]);
    assert.deepEqual(draws, ['a', 'b']);
    assert.equal(result.bitmap, bitmap);
    assert.equal(result.rows, 3);
    assert.equal(result.revision, 'r1');
    assert.deepEqual(result.lineMap, [0, 1, 2]);
    const distant = await worker.renderTile(
      {
        key: 'distant',
        id: 7,
        start: 0,
        column: 0,
        scale: 0.25,
        display: false,
        background: '#102030',
      },
      new AbortController().signal,
      pages,
    );
    assert.deepEqual([distant.width, distant.height], [288, 160]);
    assert.deepEqual(distant.lineMap, result.lineMap);
    assert.equal(distant.rows, 3);
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
});

test('scheduler bounds concurrency and suppresses canceled queued and active tile results', async () => {
  assert.equal(typeof worker.createTileScheduler, 'function');
  const pending = new Map(),
    output = [];
  let active = 0,
    peak = 0;
  const scheduler = worker.createTileScheduler({
    concurrency: 2,
    postMessage: (data) => output.push(data),
    render: async (request, signal) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => pending.set(request.key, resolve));
      active--;
      return { type: 'tile', key: request.key, bitmap: { close() {} }, aborted: signal.aborted };
    },
  });
  const tile = (key) => ({
    type: 'tile',
    key,
    id: 1,
    display: false,
    start: 0,
    column: 0,
    scale: 1,
    background: '#102030',
  });
  scheduler.receive(tile('a'));
  scheduler.receive(tile('b'));
  scheduler.receive(tile('c'));
  scheduler.receive(tile('d'));
  scheduler.receive({ type: 'cancel', keys: ['a', 'c'] });
  pending.get('a')();
  pending.get('b')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pending.has('d'));
  pending.get('d')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.deepEqual(
    output.map((item) => item.key),
    ['b', 'd'],
  );
});
