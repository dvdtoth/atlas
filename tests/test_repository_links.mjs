import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDocument, documentPage } from '../src/index/client-index.mjs';
const links = await import('../src/ui/repository-links.mjs').catch(() => ({}));
const manifest = { sourceRepo: 'owner/repo', commit: 'a'.repeat(40) };

test('repository links use the exact commit, encoded paths and one-based source line', () => {
  assert.equal(typeof links.githubSourceURL, 'function');
  assert.equal(
    links.githubSourceURL(manifest, 'src/a #%.cc', 28),
    `https://github.com/owner/repo/blob/${manifest.commit}/src/a%20%23%25.cc#L29`,
  );
  assert.equal(
    links.githubSourceURL(manifest, 'src/a.cc'),
    `https://github.com/owner/repo/blob/${manifest.commit}/src/a.cc`,
  );
  for (const path of ['../escape', '/absolute', 'a\\b', 'a/./b', 'a//b'])
    assert.equal(links.githubSourceURL(manifest, path, 0), null);
  assert.equal(links.githubSourceURL({ ...manifest, commit: 'local-123' }, 'a.cc', 0), null);
  assert.equal(
    links.githubSourceURL({ ...manifest, sourceRepo: 'https://evil.test/owner/repo' }, 'a.cc', 0),
    null,
  );
});

test('right-clicking a wrapped continuation links to its original source line', async () => {
  assert.equal(typeof links.sourceMenuTarget, 'function');
  const doc = analyzeDocument({
    id: 7,
    path: 'src/long.js',
    revision: 'r',
    text: 'first\n' + 'x'.repeat(400) + '\nlast\n',
  });
  const target = await links.sourceMenuTarget(
    manifest,
    { id: 7, path: doc.path, line: 2, display: true },
    async (args) => documentPage(doc, args),
  );
  assert.equal(target.line, 1);
  assert.ok(target.url.endsWith('#L2'));
  const raw = await links.sourceMenuTarget(
    manifest,
    { id: 7, path: doc.path, line: 2, display: false },
    () => assert.fail('raw source needs no display lookup'),
  );
  assert.ok(raw.url.endsWith('#L3'));
  await assert.rejects(
    links.sourceMenuTarget(
      manifest,
      { id: 7, path: doc.path, line: 2, display: true },
      async () => ({ lineMap: [] }),
    ),
    /source line/,
  );
});

test('archive download links use GitHub directly without REST calls or a mirror', () => {
  assert.equal(typeof links.githubArchiveURL, 'function');
  assert.equal(
    links.githubArchiveURL('owner/repo'),
    'https://github.com/owner/repo/archive/HEAD.zip',
  );
  assert.equal(
    links.githubArchiveURL('https://github.com/owner/repo', 'refs/heads/feature/a'),
    'https://github.com/owner/repo/archive/refs/heads/feature/a.zip',
  );
  for (const ref of ['../main', 'main?token=x', 'a#b', 'a\\b'])
    assert.throws(() => links.githubArchiveURL('owner/repo', ref));
});
