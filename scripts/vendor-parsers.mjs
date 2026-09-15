// Copies only pinned application dependencies. Never run scripts from imported repositories.
import { mkdir, readFile, copyFile, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const output = new URL('vendor/', root);
const versions = {
  'web-tree-sitter': '0.25.10',
  'tree-sitter-wasms': '0.1.13',
  '@zip.js/zip.js': '2.15.0',
  'web-streams-polyfill': '4.3.0',
};
for (const [name, expected] of Object.entries(versions)) {
  const pkg = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, root)));
  if (pkg.version !== expected)
    throw new Error(`Expected ${name}@${expected}; run npm ci --ignore-scripts`);
}
await mkdir(output, { recursive: true });
const files = [
  ['@zip.js/zip.js/index-native.min.js', 'zip.mjs'],
  ['@zip.js/zip.js/index.min.js', 'zip-portable.mjs'],
  ['@zip.js/zip.js/LICENSE', 'LICENSE.zip.js'],
  ['web-streams-polyfill/dist/ponyfill.mjs', 'streams.mjs'],
  ['web-streams-polyfill/LICENSE', 'LICENSE.web-streams-polyfill'],
  ['web-tree-sitter/tree-sitter.js', 'tree-sitter.js'],
  ['web-tree-sitter/tree-sitter.wasm', 'tree-sitter.wasm'],
  ['web-tree-sitter/LICENSE', 'LICENSE.web-tree-sitter'],
  ['tree-sitter-wasms/LICENSE', 'LICENSE.tree-sitter-wasms'],
  ...['c', 'cpp', 'rust', 'javascript', 'typescript', 'tsx', 'python'].map((name) => [
    `tree-sitter-wasms/out/tree-sitter-${name}.wasm`,
    `tree-sitter-${name}.wasm`,
  ]),
];
const assets = [];
for (const [source, destination] of files) {
  const from = new URL(`node_modules/${source}`, root),
    to = new URL(destination, output);
  await copyFile(from, to);
  await chmod(to, 0o644);
  // Scope portable streams to the ZIP module. Never replace browser globals:
  // fetch, rendering and the rest of Atlas retain their native implementations.
  if (destination === 'zip-portable.mjs')
    await writeFile(
      to,
      "import { ReadableStream, WritableStream, TransformStream } from './streams.mjs';\n" +
        (await readFile(to, 'utf8')),
    );
  const bytes = await readFile(to);
  assets.push({
    file: destination,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
// These version-controlled upstream licence notices accompany the binaries.
for (const name of ['c', 'cpp', 'rust', 'javascript', 'typescript', 'python']) {
  const file = `LICENSE.tree-sitter-${name}`,
    bytes = await readFile(new URL(file, output));
  assets.push({
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  new URL('manifest.json', output),
  JSON.stringify({ packages: versions, assets }, null, 2) + '\n',
);
console.log(
  `Vendored ${assets.length} assets (${assets.reduce((sum, a) => sum + a.bytes, 0)} bytes)`,
);
