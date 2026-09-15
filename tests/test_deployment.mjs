import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);

test('vendored runtime assets match the pinned integrity manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('vendor/manifest.json', root)));
  for (const asset of manifest.assets) {
    const bytes = await readFile(new URL('vendor/' + asset.file, root));
    assert.equal(bytes.length, asset.bytes, asset.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.file);
  }
});

test('entry points and module assets resolve beneath the Pages project path', async () => {
  const base = new URL('https://example.invalid/atlas/');
  async function exists(relative, from) {
    const target = new URL(relative, new URL(from, base));
    assert.ok(target.pathname.startsWith('/atlas/'), `${relative} escaped the project root`);
    await readFile(new URL(target.pathname.slice('/atlas/'.length), root));
  }
  for (const name of ['index.html', 'viewer.html', 'privacy.html']) {
    const html = await readFile(new URL(name, root), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:mjs|css|html))"/g))
      await exists(match[1], name);
    assert.match(html, /http-equiv="Content-Security-Policy"/);
  }
  async function scan(directory) {
    for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
      const name = directory + entry.name;
      if (entry.isDirectory()) {
        await scan(name + '/');
        continue;
      }
      if (!name.endsWith('.mjs')) continue;
      const source = await readFile(new URL(name, root), 'utf8');
      for (const match of source.matchAll(/['"`]((?:\.\.?\/)+[^'"`?]+\.(?:mjs|js))['"`?]/g))
        await exists(match[1], name);
      assert.doesNotMatch(
        source,
        /new Worker\(\s*['"]/,
        'workers must resolve relative to their module',
      );
    }
  }
  await scan('src/');
});
