import assert from 'node:assert/strict';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js/index-native.js';
import './safari-environment.mjs';
const chromium = process.argv.includes('--chromium');
if (chromium)
  navigator.userAgent =
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const text = '\ufeffexport function héllo() {\r\n return "世界";\r\n}\r\n';
const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, zip64: true });
await writer.add('repo-main/src/main.js', new TextReader(text));
await writer.add('repo-main/README.md', new TextReader('hello'), { level: 0 });
const archive = new Blob([await writer.close()]);
const globals = Object.fromEntries(
  ['ReadableStream', 'WritableStream', 'TransformStream', 'DecompressionStream'].map((key) => [
    key,
    globalThis[key],
  ]),
);
const { CachedZipReader } = await import('../../src/import/zip-reader.mjs');
const readable = new CachedZipReader(archive).createReadable();
assert.equal(
  readable instanceof globals.ReadableStream,
  chromium,
  'Select stream implementation for the actual browser engine',
);
await readable.cancel();
const { importZipFiles } = await import('../../src/import/zip-import.mjs');
const docs = [];
const report = await importZipFiles(archive, { onFile: async (doc) => docs.push(doc) });
assert.equal(report.downloaded, 2);
assert.deepEqual(
  docs.map((d) => d.path),
  ['README.md', 'src/main.js'],
);
assert.equal(docs[1].text, text);
for (const [key, value] of Object.entries(globals)) assert.equal(globalThis[key], value);
console.log(chromium ? 'native ZIP passed' : 'portable ZIP passed');
