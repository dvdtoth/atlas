import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// An explicit allowlist keeps tests, tooling and local data out of the website.
for (const name of [
  'index.html',
  'viewer.html',
  'privacy.html',
  '_headers',
  'LICENSE',
  'THIRD_PARTY.md',
  'src',
  'styles',
  'vendor',
]) {
  await cp(new URL(name, root), new URL(name, out), { recursive: true });
}
await writeFile(new URL('.nojekyll', out), '');
console.log('Static application ready in dist/. No runtime backend required.');
