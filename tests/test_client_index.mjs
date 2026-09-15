import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readNode, surface } from '../src/render/core.mjs';
import {
  analyzeDocument,
  documentMetadata,
  buildSnapshot,
  documentPage,
  sourceAddress,
} from '../src/index/client-index.mjs';

const doc = (text, id = 1, path = 'src/main.js') =>
  analyzeDocument({
    id,
    path,
    revision: `revision-${id}`,
    text,
    bytes: new TextEncoder().encode(text).length,
  });
const repo = {
  fullName: 'example/repository',
  name: 'repository',
  commit: 'immutable-commit',
  projectId: 'project-one',
};
const snapshot = (docs) =>
  buildSnapshot(docs.map(documentMetadata), repo, async (id) => docs.find((d) => d.id === id));
const nodesOf = (result) =>
  Array.from({ length: result.manifest.count }, (_, i) => readNode(new DataView(result.nodes), i));

test('snapshot repository analytics metadata requires verified public GitHub origin', async () => {
  const d = doc('const a = 1;');
  for (const origin of [
    {},
    { source: 'zip', public: true },
    { source: 'folder', public: true },
    { source: 'github' },
    { source: 'github', public: false },
    { source: 'github', public: true },
  ]) {
    const result = await buildSnapshot(
      [documentMetadata(d)],
      { ...repo, ...origin },
      async () => d,
    );
    assert.equal(
      result.manifest.publicRepository,
      origin.source === 'github' && origin.public === true ? repo.fullName : null,
    );
  }
});

test('raw paging preserves exact logical rows, revision, CRLF, lone CR and no phantom final row', () => {
  const source = '\tαe\u0301\r\nsecond\nlast\r';
  const d = doc(source),
    page = documentPage(d, { count: 10 });
  assert.equal(d.text, source);
  assert.equal(page.revision, 'revision-1');
  assert.deepEqual(page.sourceLines, ['\tαe\u0301', 'second', 'last\r']);
  assert.deepEqual(page.lineMap, [0, 1, 2]);
  assert.deepEqual(page.columnMap, [0, 0, 0]);
  assert.equal(doc('x\n').lines, 1);
  assert.equal(doc('\n\n').lines, 2);
  assert.deepEqual(documentPage(doc(''), {}).sourceLines, []);
  assert.deepEqual(documentPage(d, { start: 3, count: 1 }).sourceLines, []);
  assert.throws(() => documentPage(d, { start: 4 }), /start.*line count/i);
  assert.throws(() => documentPage(d, { count: 0 }), /count/i);
});

test('profiles use conservative scalar widths, tab stops, blank rows and a 4096 raw cap', () => {
  const d = doc(' \tx\n界\t🙂e\u0301\n \t\n' + 'x'.repeat(5000));
  assert.equal(d.columns, 4096);
  assert.deepEqual([...d.rawProfile], [4 | (1 << 16), 11 << 16, 0, 4096 << 16]);
  assert.equal(doc('界\t🙂e\u0301\n').columns, 14);
  assert.equal(doc(' \tx\r\n').columns, 5);
  assert.equal(doc('\uFEFF').rawProfile[0], 3 << 16);
});

test('p90 + 16 rounded to 8 clamps between 80 and 240, ignoring blank widths', () => {
  const d = doc(Array(9).fill('x'.repeat(81)).concat('z'.repeat(301), ' '.repeat(1000)).join('\n'));
  assert.deepEqual(d.wrapping, { columns: 104, lines: 13, sourceLines: 11 });
  assert.equal(d.displayColumns, 104);
  assert.equal(d.displayProfile.length, 13);
  assert.deepEqual([...d.wraps], [9, 301, 9]);
  assert.equal(doc('x'.repeat(241)).displayColumns, 240);
  assert.equal(doc('x'.repeat(240)).wrapping, null);
  assert.equal(doc('x\n'.repeat(9) + 'y'.repeat(81)).displayColumns, 80);
  assert.equal(doc(' '.repeat(5000)).wrapping, null);
});

test('display pages preserve graphemes and empty continuation rows at wrap seams', () => {
  const cluster = 'e' + '\u0301'.repeat(90);
  const d = doc('short\n'.repeat(9) + 'x'.repeat(79) + cluster + '\tZ\nend');
  assert.equal(d.wrapping.columns, 80);
  const page = documentPage(d, { start: 9, count: 10, display: true });
  assert.deepEqual(page.sourceLines, ['x'.repeat(79) + cluster, '', '', '', '  Z', 'end']);
  assert.deepEqual(page.lineMap, [9, 9, 9, 9, 9, 10]);
  assert.deepEqual(page.columnMap, [0, 80, 160, 240, 320, 0]);
  assert.equal(page.sourceTotalLines, 11);
  assert.equal(page.totalLines, 15);
  assert.deepEqual(documentPage(doc('界\tX'), { display: true }).sourceLines, ['界 X']);
});

test('source addresses map continuations and keep exact-boundary endpoints on the preceding row', () => {
  const d = doc('x\n'.repeat(9) + 'z'.repeat(160) + '\nafter');
  assert.deepEqual(sourceAddress(d, { line: 9, column: 80 }), {
    id: 1,
    revision: 'revision-1',
    line: 9,
    column: 80,
    displayLine: 10,
    displayColumn: 0,
  });
  assert.equal(sourceAddress(d, { line: 9, column: 160 }).displayLine, 10);
  assert.equal(sourceAddress(d, { line: 9, column: 160 }).displayColumn, 80);
  assert.equal(sourceAddress(d, { line: 10, column: 2 }).displayLine, 11);
  assert.equal(sourceAddress(d, { line: 9, column: 999 }).column, 160);
  assert.equal(sourceAddress(doc(''), { line: 0, column: 0 }).displayLine, 0);
  assert.throws(() => sourceAddress(d, { line: 11, column: 0 }), /line.*line count/i);
});

test('metadata is compact and does not retain text, offsets or source profiles', () => {
  const d = doc('hello\n');
  assert.deepEqual(documentMetadata(d), {
    id: 1,
    path: 'src/main.js',
    revision: 'revision-1',
    bytes: 6,
    lines: 1,
    columns: 5,
    displayLines: 1,
    displayColumns: 5,
  });
  const stored = structuredClone(d);
  assert.deepEqual(documentPage(stored, {}), documentPage(d, {}));
});

test('binary manifest and DFS records preserve document identities and parent array indexes', async () => {
  const docs = [doc('a', 1, 'z/a.js'), doc('b', 2, 'a/b.js'), doc('', 3, 'empty.txt')];
  const result = await snapshot(docs),
    nodes = nodesOf(result);
  assert.equal(result.nodes.byteLength, nodes.length * 96);
  assert.equal(result.manifest.nodeStride, 96);
  assert.equal(result.manifest.previewSamples, 16);
  assert.equal(result.manifest.stats.files, 3);
  assert.equal(result.manifest.stats.lines, 2);
  assert.equal(result.manifest.sourceRepo, repo.fullName);
  assert.equal(result.manifest.commit, repo.commit);
  assert.equal(result.manifest.projectId, repo.projectId);
  assert.equal(result.manifest.maxId, Math.max(...nodes.map((n) => n.id)));
  assert.deepEqual(result.manifest.root, [0, 0, 100000, 70000]);
  assert.equal(nodes[0].parent, 0xffffffff);
  const decoder = new TextDecoder(),
    paths = new Uint8Array(result.paths);
  for (const n of nodes) {
    if (n.index) assert.ok(n.parent < n.index);
    const path = decoder.decode(paths.subarray(n.pathOffset, n.pathOffset + n.pathLength));
    if (n.kind) assert.equal(path, docs.find((d) => d.id === n.id).path);
  }
  assert.deepEqual(
    nodes.filter((n) => n.kind).map((n) => n.id),
    [2, 3, 1],
  );
});

function assertPartition(nodes, parent) {
  const children = nodes.filter((n) => n.parent === parent.index);
  let area = 0;
  for (const [i, n] of children.entries()) {
    assert.ok([n.x, n.y, n.w, n.h].every(Number.isFinite));
    assert.ok(n.w > 0 && n.h > 0 && n.x + n.w > n.x && n.y + n.h > n.y);
    assert.ok(
      n.x >= parent.x &&
        n.y >= parent.y &&
        n.x + n.w <= parent.x + parent.w &&
        n.y + n.h <= parent.y + parent.h,
    );
    area += n.w * n.h;
    for (const a of children.slice(0, i))
      assert.ok(n.x + n.w <= a.x || a.x + a.w <= n.x || n.y + n.h <= a.y || a.y + a.h <= n.y);
  }
  assert.ok(Math.abs(area - parent.w * parent.h) <= parent.w * parent.h * 1e-12);
}

test('ordered binary packing gives equal siblings aligned path-ordered quadrants', async () => {
  const result = await snapshot(['d', 'b', 'c', 'a'].map((p, i) => doc('x', i + 1, p))),
    nodes = nodesOf(result);
  assert.deepEqual(
    nodes.slice(1).map((n) => [n.id, n.x, n.y, n.w, n.h]),
    [
      [4, 0, 0, 50000, 35000],
      [2, 0, 35000, 50000, 35000],
      [3, 50000, 0, 50000, 35000],
      [1, 50000, 35000, 50000, 35000],
    ],
  );
  assertPartition(nodes, nodes[0]);
});

test('nested skewed documents completely partition parents without overlap or escaped edges', async () => {
  const docs = Array.from({ length: 220 }, (_, i) =>
    doc(
      (' '.repeat(i % 40) + 'x'.repeat(i % 170) + '\n').repeat(
        i === 0 ? 30000 : 1 + ((i * 719) % 300),
      ),
      i + 1,
      `folder${i % 7}/sub${i % 3}/${String(i).padStart(4, '0')}.js`,
    ),
  );
  const nodes = nodesOf(await snapshot(docs));
  for (const n of nodes) if (!n.kind) assertPartition(nodes, n);
  for (const n of nodes)
    if (n.kind) {
      assert.ok(n.panels >= 1 && n.panels <= 32);
      const d = docs.find((d) => d.id === n.id),
        s = surface({ ...n, lines: d.displayLines, columns: d.displayColumns });
      const panels = Array.from({ length: s.panels }, (_, p) => s.panel(p));
      assert.equal(
        panels.reduce((sum, p) => sum + p.count, 0),
        d.displayLines,
      );
      assert.ok(
        Math.max(...panels.map((p) => p.count)) - Math.min(...panels.map((p) => p.count)) <= 1,
      );
    }
});

test('intrinsic height cap prevents a huge document from taking its uncapped weight', async () => {
  const huge = doc(('x'.repeat(80) + '\n').repeat(100000), 1, 'a');
  const medium = doc(('x'.repeat(80) + '\n').repeat(10000), 2, 'b');
  const nodes = nodesOf(await snapshot([huge, medium]));
  const ratio = (nodes[1].w * nodes[1].h) / (nodes[2].w * nodes[2].h);
  assert.ok(ratio < 6 && ratio > 1);
});

test('role-first colors override type families while retaining type shades', async () => {
  const paths = [
    'src/main.js',
    'tests/main.js',
    'tests/main.ts',
    'docs/main.js',
    'README.js',
    'build/main.js',
    'assets/main.js',
    'package.json',
  ];
  const nodes = nodesOf(await snapshot(paths.map((p, i) => doc('x', i + 1, p))));
  const colors = new Map(nodes.filter((n) => n.kind).map((n) => [n.id, n.color]));
  assert.notEqual(colors.get(1), colors.get(2));
  assert.notEqual(colors.get(2), colors.get(3));
  assert.equal(colors.get(4), colors.get(5));
  assert.notEqual(colors.get(6), colors.get(7));
  assert.ok([...colors.values()].every((c) => c >>> 24 === 255));
  // Reference values for stable role and file-type colors.
  assert.deepEqual(
    paths.map((_, i) => colors.get(i + 1)),
    [
      4292456021, 4292433298, 4292761503, 4286437717, 4286437717, 4283802585, 4283786457,
      4283802585,
    ],
  );
});

test('preview offsets reference exactly sixteen balanced-bin samples per display and raw panel', async () => {
  const docs = [
    doc('x\n'.repeat(9) + ' '.repeat(4) + 'Z'.repeat(200) + '\n', 1, 'a.js'),
    doc('', 2, 'empty'),
  ];
  const result = await snapshot(docs),
    view = new DataView(result.nodes),
    previews = new Uint32Array(result.previews);
  const nodes = nodesOf(result).filter((n) => n.kind);
  let offset = 0;
  for (const n of nodes) {
    const d = docs.find((d) => d.id === n.id),
      display = readNode(view, n.index, true);
    assert.equal(display.preview, offset);
    offset += n.panels * 16;
    assert.equal(n.preview, offset);
    offset += n.panels * 16;
    for (const [profile, lines, base] of [
      [d.displayProfile ?? d.rawProfile, d.displayLines, display.preview],
      [d.rawProfile, d.lines, n.preview],
    ]) {
      const total = Math.max(1, lines),
        q = Math.floor(total / n.panels),
        r = total % n.panels;
      for (let p = 0; p < n.panels; p++)
        for (let s = 0; s < 16; s++) {
          const start = p * q + Math.min(p, r),
            length = q + (p < r ? 1 : 0);
          const lo = start + Math.floor((s * length) / 16),
            hi = Math.min(lines, start + Math.floor(((s + 1) * length) / 16));
          const candidates = [...profile.slice(lo, hi)];
          const chosen = candidates.reduce(
            (best, v) =>
              v >>> 16 && (v & 65535) + (v >>> 16) > (best & 65535) + (best >>> 16) ? v : best,
            0,
          );
          assert.equal(previews[base + p * 16 + s], chosen);
        }
    }
  }
  assert.equal(previews.length, offset);
});

test('building uses sequential document reads and rejects stale/missing profiles', async () => {
  const docs = [doc('x', 1, 'a'), doc('y', 2, 'b')];
  let active = 0,
    peak = 0,
    calls = 0;
  const progress = [];
  await buildSnapshot(
    docs.map(documentMetadata),
    repo,
    async (id) => {
      calls++;
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return structuredClone(docs[id - 1]);
    },
    (p) => progress.push(p),
  );
  assert.equal(peak, 1);
  assert.equal(calls, 2);
  assert.ok(progress.length > 0);
  await assert.rejects(
    buildSnapshot(docs.map(documentMetadata), repo, async () => undefined),
    /missing.*document/i,
  );
  await assert.rejects(
    buildSnapshot(docs.map(documentMetadata), repo, async (id) => ({
      ...docs[id - 1],
      revision: 'stale',
    })),
    /revision/i,
  );
});

test('empty repositories fail clearly and duplicate identities or paths are rejected', async () => {
  await assert.rejects(snapshot([]), /no.*(?:files|documents)|empty repository/i);
  await assert.rejects(snapshot([doc('x', 1, 'a'), doc('y', 1, 'b')]), /duplicate.*id/i);
  await assert.rejects(snapshot([doc('x', 1, 'a'), doc('y', 2, 'a')]), /duplicate.*path/i);
});

test('Unicode paths use UTF-8 ordering and preserve their exact encoded bytes', async () => {
  const docs = ['😀.js', '\uE000.js', 'α/界.js', 'a.js'].map((path, i) => doc('x', i + 1, path));
  const result = await snapshot(docs),
    nodes = nodesOf(result),
    bytes = new Uint8Array(result.paths),
    decoder = new TextDecoder();
  assert.deepEqual(
    nodes
      .filter((n) => n.kind)
      .map((n) => decoder.decode(bytes.subarray(n.pathOffset, n.pathOffset + n.pathLength))),
    ['a.js', 'α/界.js', '\uE000.js', '😀.js'],
  );
});

test('long-line pages preserve source text without requiring preceding projected rows', () => {
  const text = 'a'.repeat(1_000_000),
    d = doc(text);
  assert.equal(d.columns, 4096);
  assert.equal(d.displayColumns, 240);
  assert.equal(d.displayLines, Math.ceil(text.length / 240));
  const last = documentPage(d, { start: d.displayLines - 1, count: 1, display: true });
  assert.equal(last.sourceLines[0], 'a'.repeat(160));
  assert.equal(last.columnMap[0], text.length - 160);
  assert.equal(documentPage(d).sourceLines[0], text);
});

test('oversized previews fail before reading or allocating all stored documents', async () => {
  const metas = Array.from({ length: 33000 }, (_, i) => ({
    id: i + 1,
    path: `${String(i).padStart(6, '0')}.js`,
    revision: 'r',
    bytes: 1_000_000,
    lines: 1_000_000,
    columns: 80,
    displayLines: 1_000_000,
    displayColumns: 80,
  }));
  let reads = 0;
  await assert.rejects(
    buildSnapshot(metas, repo, async () => {
      reads++;
      throw new Error('Unexpected source read');
    }),
    /preview buffer exceeds.*128 MiB/i,
  );
  assert.equal(reads, 0);
});

test('snapshot buffers load in the unchanged geometry worker, including empty source', async () => {
  const docs = [doc('x\n'.repeat(9) + 'Z'.repeat(8000), 1, 'src/a.js'), doc('', 2, 'empty.txt')];
  const result = await snapshot(docs),
    nodeView = new DataView(result.nodes),
    nodes = nodesOf(result);
  const url = new URL('../src/render/geometry-worker.mjs', import.meta.url).href;
  const worker = new Worker(
    `import {parentPort} from 'node:worker_threads';globalThis.onmessage=null;globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);await import(${JSON.stringify(url)});parentPort.on('message',data=>onmessage({data}));`,
    { eval: true },
  );
  try {
    const geometry = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (r) => {
        if (r.type === 'geometry') resolve(r);
        if (r.type === 'error') reject(Error(r.message));
      });
      worker.postMessage({ nodes: result.nodes.slice(0) });
    });
    assert.equal(geometry.files, 2);
    assert.equal(geometry.map.byteLength, 2 * 96);
    assert.ok(geometry.folds > 0);
    assert.equal(geometry.first.byteLength, nodes.length * 4);
    const records = new DataView(geometry.map);
    for (let i = 0; i < 2; i++) {
      const index = records.getUint32(i * 96 + 64, true),
        n = readNode(nodeView, index, true);
      assert.equal(records.getUint32(i * 96 + 68, true), n.preview);
      assert.equal(records.getUint32(i * 96 + 72, true), n.lines);
      assert.equal(records.getUint32(i * 96 + 76, true), n.panels);
    }
  } finally {
    await worker.terminate();
  }
});
