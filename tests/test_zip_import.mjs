import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js/index-native.js';
import { importZipFiles } from '../src/import/zip-import.mjs';

export async function archive(entries, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, ...options });
  for (const [path, text, opts = {}] of entries) await writer.add(path, new TextReader(text), opts);
  return new File([await writer.close()], 'example-main.zip', { type: 'application/zip' });
}
const read = async (zip, options = {}) => {
  const docs = [];
  const report = await importZipFiles(zip, { onFile: async (doc) => docs.push(doc), ...options });
  return { docs, report };
};

test('ZIP extracts stored/deflated/ZIP64 entries in source order, strips wrapper, preserves exact UTF-8', async () => {
  const text = '\ufeffexport function héllo() {\r\n return "世界";\r\n}\r\n';
  const zip = await archive(
    [
      ['example-main/z.txt', 'last', { level: 0 }],
      ['example-main/src/main.js', text],
    ],
    { zip64: true },
  );
  const { docs, report } = await read(zip);
  assert.deepEqual(
    docs.map((d) => d.path),
    ['src/main.js', 'z.txt'],
  );
  assert.equal(docs[0].text, text);
  const digest = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  ).toString('hex');
  assert.equal(docs[0].revision, digest);
  assert.equal(report.downloaded, 2);
  assert.equal(report.bytes, new TextEncoder().encode(text + 'last').length);
});
test('ZIP preserves multiple root entries and skips build output, macOS metadata, symlinks and binary', async () => {
  const zip = await archive([
    ['src/main.js', 'let value=1;'],
    ['README.md', 'hello'],
    ['dist/bundle.js', 'skip'],
    ['__MACOSX/._README.md', 'metadata'],
    ['.DS_Store', 'metadata'],
    ['link', '../elsewhere', { unixMode: 0o120777 }],
    ['image.bin', '\0binary'],
    ['big.txt', 'x'.repeat(100)],
  ]);
  const { docs, report } = await read(zip, { maxFileBytes: 32 });
  assert.deepEqual(
    docs.map((d) => d.path),
    ['README.md', 'src/main.js'],
  );
  assert.equal(report.skipped, 6);
  assert.equal(report.skipReasons.symlink, 1);
  assert.equal(report.skipReasons.binary, 1);
  assert.equal(report.skipReasons.oversize, 1);
});
test('ZIP preserves ordered source admission while an earlier callback is blocked', async () => {
  const zip = await archive([
    ['a.js', 'let a=1;'],
    ['b.js', 'let b=1;'],
  ]);
  let release,
    seen = 0;
  const pending = read(zip, {
    onFile: async () => {
      seen++;
      if (seen === 1)
        await new Promise((r) => {
          release = r;
        });
    },
  });
  while (!release) await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(seen, 1);
  release();
  await pending;
  assert.equal(seen, 2);
});
test('ZIP import limits compressed input, entry count, and expanded source bytes', async () => {
  const zip = await archive([
    ['a.txt', 'x'.repeat(40)],
    ['b.txt', 'y'.repeat(40)],
  ]);
  await assert.rejects(read(zip, { maxArchiveBytes: 10 }), /ZIP.*limit/i);
  await assert.rejects(read(zip, { maxEntries: 1 }), /entry.*limit/i);
  await assert.rejects(read(zip, { maxBytes: 60 }), /expanded.*budget/i);
});
test('ZIP abort after one indexed file stops extraction and retains AbortError', async () => {
  const controller = new AbortController(),
    zip = await archive([
      ['a.txt', 'a'],
      ['b.txt', 'b'],
    ]);
  let seen = 0;
  await assert.rejects(
    read(zip, {
      signal: controller.signal,
      onFile: async () => {
        seen++;
        controller.abort();
      },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(seen, 1);
});
test('ZIP rejects unsafe paths, duplicate paths, encrypted files and malformed bytes', async () => {
  for (const path of [
    '../oops.js',
    '/absolute.js',
    'C:/drive.js',
    'root/../escape.js',
    'root\\escape.js',
    'root/\u0001bad.js',
  ]) {
    // The writer rejects unsafe names too; permit them explicitly to exercise the reader.
    const zip = await archive([[path, 'bad']], { filenameValidation: 'tolerant' });
    await assert.rejects(read(zip), /filename|path/i);
  }
  const zip = await archive([
    ['a.txt', 'same'],
    ['b.txt', 'same'],
  ]);
  const data = new Uint8Array(await zip.arrayBuffer());
  for (let i = 0; i < data.length - 5; i++)
    if (
      data[i] === 98 &&
      data[i + 1] === 46 &&
      data[i + 2] === 116 &&
      data[i + 3] === 120 &&
      data[i + 4] === 116
    )
      data[i] = 97;
  await assert.rejects(read(new Blob([data])), /duplicate|ambiguous/i);
  await assert.rejects(
    read(await archive([['secret.txt', 'secret']], { password: 'secret' })),
    /encrypted/i,
  );
  await assert.rejects(read(new Blob(['not a ZIP'])), /ZIP/i);
  await assert.rejects(read(zip.slice(0, -12)), /ZIP/i);
});
test('ZIP rejects corrupted stored data and inconsistent uncompressed sizes', async () => {
  const zip = await archive([['a.txt', 'abcdef']], { level: 0 });
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer),
    start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  bytes[start] ^= 1;
  await assert.rejects(read(new Blob([bytes])), /CRC|checksum|signature/i);
  const bomb = new Uint8Array(await zip.arrayBuffer()),
    bv = new DataView(bomb.buffer);
  bv.setUint32(22, 1, true);
  for (let i = 0; i < bomb.length - 46; i++)
    if (bv.getUint32(i, true) === 0x02014b50) bv.setUint32(i + 24, 1, true);
  await assert.rejects(read(new Blob([bomb])), /size|length|expanded/i);
});

test('ZIP shares bounded compressed reads across neighbouring file headers and bodies', async () => {
  const zip = await archive(
    Array.from({ length: 120 }, (_, i) => [
      `repo/${String(i).padStart(3, '0')}.txt`,
      `source ${i}\n`,
    ]),
    { level: 0 },
  );
  let reads = 0,
    total = 0;
  class CountedBlob extends Blob {
    slice(...args) {
      const value = super.slice(...args);
      return new CountedBlob([value]);
    }
    async arrayBuffer() {
      reads++;
      total += this.size;
      return super.arrayBuffer();
    }
    stream() {
      reads++;
      total += this.size;
      return super.stream();
    }
  }
  const counted = new CountedBlob([zip]),
    { docs } = await read(counted);
  assert.equal(docs.length, 120);
  assert.equal(docs[119].text, 'source 119\n');
  assert.ok(reads <= 4, `Expected bulk compressed reads, got ${reads}`);
  assert.ok(
    total <= zip.size * 2,
    `Repeated ${total} compressed bytes for ${zip.size} archive bytes`,
  );
});
