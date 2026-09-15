import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbols, searchSymbols, searchText } from '../src/index/client-search.mjs';

const doc = (path, text, id = 1) => ({ id, path, text, revision: 'fixture-sha' });
const fixtures = [
  [
    'code.c',
    '// int phantom() {}\nconst char *s = "void imaginary() {}";\nint actual(int a) { return a; }\n',
    ['s', 'actual'],
  ],
  [
    'code.hpp',
    'namespace Space {\nclass Box {\npublic:\n int actual() { return 1; }\n};\n}\n',
    ['Space', 'Box', 'actual'],
  ],
  [
    'code.rs',
    '// fn phantom() {}\nstruct Box {}\nimpl Box { fn actual(&self) {} }\nconst LIMIT: i32 = 1;\n',
    ['Box', 'actual', 'LIMIT'],
  ],
  [
    'code.js',
    '// function phantom() {}\nconst text = "function imaginary() {}";\nfunction actual() { const local = 1; }\nconst arrow = () => 1;\n',
    ['text', 'actual', 'arrow'],
  ],
  [
    'code.ts',
    'interface Box { actual(): number; }\ntype Alias = string;\nfunction actual(): number { return 1; }\n',
    ['Box', 'actual', 'Alias', 'actual'],
  ],
  [
    'code.tsx',
    'interface Props { name: string }\nexport const Actual = (p: Props) => <div>{p.name}</div>;\n',
    ['Props', 'Actual'],
  ],
  [
    'code.py',
    '# def phantom(): pass\ntext = "def imaginary(): pass"\nclass Box:\n\tdef actual(self):\n\t\tpass\n',
    ['Box', 'actual'],
  ],
];

function partitioned(report, text) {
  const lines = text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
  let at = 0;
  for (const segment of report.segments) {
    assert.equal(segment.startLine, at);
    assert.ok(segment.endLine > at);
    assert.ok(
      ['source', 'function', 'type', 'namespace', 'declaration', 'comment'].includes(segment.kind),
    );
    at = segment.endLine;
  }
  assert.equal(at, lines);
}

for (const [path, text, names] of fixtures) {
  test(`real WASM declarations and complete line partition: ${path}`, async () => {
    const report = await extractSymbols(doc(path, text));
    assert.equal(report.complete, true, JSON.stringify(report));
    assert.match(report.parser, /tree-sitter-/);
    assert.equal(report.state, 'parsed');
    assert.deepEqual(
      report.symbols.map((s) => s.name),
      names,
    );
    assert.ok(
      report.symbols.every(
        (s) => s.kind === 'symbol' && s.id === 1 && s.path === path && s.revision === 'fixture-sha',
      ),
    );
    partitioned(report, text);
    assert.doesNotThrow(() => structuredClone(report));
  });
}

test('symbol addresses target the name, with tab stops and non-ASCII scalar widths', async () => {
  const text = 'class Café {\n\t/* é🙂 */ actual() {}\n}\n';
  const { symbols } = await extractSymbols(doc('unicode.js', text));
  const name = symbols.find((s) => s.name === 'actual');
  assert.equal(name.line, 1);
  assert.equal(name.column, 17); // tab 4 + /* 3 + é 3 + emoji 3 + */ 3 + space 1
  assert.equal(name.endLine, 1);
  assert.equal(name.endColumn, 23);
  assert.equal(name.scope, 'Café');
});

test('unsupported, oversize, NUL and damaged syntax have explicit incomplete coverage', async () => {
  for (const [path, text, state] of [
    ['notes.md', '# actual\n', 'unsupported'],
    ['large.js', ' '.repeat(2 * 1024 * 1024 + 1), 'limited'],
    ['binary.js', 'function actual() {}\0', 'limited'],
    ['broken.js', 'function good() {}\n/* never closes\nfunction phantom() {}', 'partial'],
  ]) {
    const report = await extractSymbols(doc(path, text));
    assert.equal(report.complete, false);
    assert.equal(report.state, state);
    assert.ok(!report.symbols.some((s) => s.name === 'phantom'));
    partitioned(report, text);
  }
});

test('empty supported document has no invented source line or symbol', async () => {
  const report = await extractSymbols(doc('empty.js', ''));
  assert.equal(report.complete, true);
  assert.deepEqual(report.symbols, []);
  assert.deepEqual(report.segments, []);
});

test('symbol matching ranks exact, prefix and substring while counting the entire index', () => {
  const symbols = ['react', 'REACTOR', 'preReact', 'other'].map((name, i) => ({
    id: i + 1,
    path: `${name}.js`,
    name,
    line: 0,
    column: 0,
  }));
  const report = searchSymbols(symbols, 'react', 2);
  assert.deepEqual(
    report.results.map((s) => s.name),
    ['react', 'REACTOR'],
  );
  assert.equal(report.total, 3);
  assert.equal(report.complete, true);
  assert.equal(report.truncated, true);
  assert.equal(report.status, 'complete');
  assert.deepEqual(searchSymbols(symbols, '').results, []);
});

test('text search scans literal substrings across lines, limits output, and keeps exact addresses', async () => {
  const documents = [
    doc('a.txt', '\té🙂 HIT hit\n.* literal\nnext\nline', 1),
    doc('b.txt', 'hit hit hit', 2),
  ];
  const report = await searchText(
    documents.map(({ text, ...meta }) => meta),
    async (id) => documents.find((d) => d.id === id),
    'hit',
    { limit: 2 },
  );
  assert.equal(report.total, 5);
  assert.equal(report.results.length, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.complete, true);
  assert.equal(report.totalIsLowerBound, false);
  assert.deepEqual(report.matchedFiles, [
    { id: 1, count: 2 },
    { id: 2, count: 3 },
  ]);
  assert.equal(report.results[0].column, 11);
  assert.equal(report.results[0].endColumn, 14);
  assert.equal(report.results[0].revision, 'fixture-sha');
  assert.equal(
    (await searchText(documents, async (id) => documents.find((d) => d.id === id), '.*')).total,
    1,
  );
  const multiline = await searchText(
    documents,
    async (id) => documents.find((d) => d.id === id),
    'next\nline',
  );
  assert.equal(multiline.total, 1);
  assert.equal(multiline.results[0].line, 2);
  assert.equal(multiline.results[0].endLine, 3);
});

test('Unicode lowercase expansion preserves original source match coordinates', async () => {
  const document = doc('unicode.txt', 'İ\tTARGET target\nİX');
  const report = await searchText([document], async () => document, 'target');
  assert.equal(report.results[0].column, 4);
  assert.equal(report.results[0].endColumn, 10);
  const dotted = await searchText([document], async () => document, 'x');
  assert.equal(dotted.results[0].column, 3);
});

test('text scanning yields and obeys cancellation within a single large source', async () => {
  const controller = new AbortController();
  let reads = 0;
  const document = doc('large.txt', 'a'.repeat(2 * 1024 * 1024));
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(
    searchText(
      [document],
      async () => {
        reads++;
        return document;
      },
      'absent',
      { signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
  assert.equal(reads, 1);
});

test('missing or stale documents produce partial reports, never stale result revisions', async () => {
  const metas = [doc('first.txt', '', 1), doc('missing.txt', '', 2), doc('stale.txt', '', 3)];
  const report = await searchText(
    metas,
    async (id) =>
      id === 1
        ? doc('first.txt', 'find', 1)
        : id === 2
          ? null
          : { ...doc('stale.txt', 'find', 3), revision: 'stale' },
    'find',
  );
  assert.equal(report.total, 1);
  assert.equal(report.complete, false);
  assert.equal(report.status, 'partial');
  assert.equal(report.totalIsLowerBound, true);
  assert.equal(report.skippedDocuments, 2);
});

test('query and result budgets reject unbounded requests', async () => {
  assert.throws(() => searchSymbols([], 'x', 201), /limit/i);
  assert.throws(() => searchSymbols([], 'x'.repeat(1025)), /query/i);
  await assert.rejects(
    searchText([], async () => null, '\0'),
    /query/i,
  );
});

test('chunk boundaries count nonoverlapping literal matches once', async () => {
  const document = doc('boundary.txt', 'a'.repeat(65540));
  const report = await searchText([document], async () => document, 'aaa');
  assert.equal(report.total, Math.floor(document.text.length / 3));
  assert.equal(report.complete, true);
  const crossing = doc('boundary.txt', 'z'.repeat(65534) + 'needle' + 'z'.repeat(10));
  const hit = await searchText([crossing], async () => crossing, 'needle');
  assert.equal(hit.total, 1);
  assert.equal(hit.results[0].column, 65534);
  assert.equal(hit.results[0].endColumn, 65540);
});

test('partial lowercase expansion matches target the complete original scalar', async () => {
  const document = doc('case.txt', 'İ word');
  const report = await searchText([document], async () => document, 'i');
  assert.equal(report.total, 1);
  assert.equal(report.results[0].name, 'İ');
  assert.equal(report.results[0].column, 0);
  assert.equal(report.results[0].endColumn, 3);
});

test('parse size, nesting and record limits are explicit and partition the source', async () => {
  const text = 'function actual() {\n' + '{'.repeat(300) + '1;' + '}'.repeat(300) + '\n}';
  const report = await extractSymbols(doc('nested.js', text));
  assert.equal(report.complete, false);
  assert.equal(report.state, 'limited');
  partitioned(report, text);
  const many = 'const value = 1;\n'.repeat(20000);
  const start = performance.now();
  const bounded = await extractSymbols(doc('many.js', many));
  assert.equal(bounded.complete, false);
  assert.equal(bounded.state, 'limited');
  assert.ok(bounded.symbols.length <= 8192);
  assert.ok(
    performance.now() - start < 2000,
    'parser must return under a generous outer time bound',
  );
  partitioned(bounded, many);
});

test('text match budget reports lower bounds and progress', async () => {
  const document = doc('frequent.txt', 'a'.repeat(200000));
  let progress;
  const report = await searchText([document], async () => document, 'a', {
    onProgress: (value) => {
      progress = value;
    },
  });
  assert.equal(report.total, 100000);
  assert.equal(report.complete, false);
  assert.equal(report.totalIsLowerBound, true);
  assert.equal(report.results.length, 40);
  assert.equal(progress.total, 100000);
});

test('extensionless files are explicitly unsupported', async () => {
  for (const path of ['c', 'folder/ts', '.js', 'code.constructor', 'code.__proto__']) {
    const report = await extractSymbols(doc(path, 'function actual() {}'));
    assert.equal(report.state, 'unsupported');
  }
});

test('matched-file truncation distinguishes an exact boundary from an omitted file', () => {
  const symbols = Array.from({ length: 25000 }, (_, i) => ({
    id: i + 1,
    path: `file${i}.js`,
    name: 'hit',
    line: 0,
    column: 0,
  }));
  const exact = searchSymbols(symbols, 'hit');
  assert.equal(exact.matchedFiles.length, 25000);
  assert.equal(exact.matchedFilesTruncated, false);
  symbols.push({ id: 25001, path: 'last.js', name: 'hit', line: 0, column: 0 });
  const bounded = searchSymbols(symbols, 'hit');
  assert.equal(bounded.total, 25001);
  assert.equal(bounded.matchedFiles.length, 25000);
  assert.equal(bounded.matchedFilesTruncated, true);
});

test('CRLF and lone CR addresses use the same source widths as the map profile', async () => {
  const document = doc('line-endings.txt', 'A\rbhit\r\n\thit\réhit');
  const report = await searchText([document], async () => document, 'hit');
  assert.deepEqual(
    report.results.map((r) => [r.line, r.column]),
    [
      [0, 3],
      [1, 4],
      [1, 11],
    ],
  );
});
