import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepository,
  resolveRepository,
  listRepository,
  downloadRepository,
} from '../src/import/github-import.mjs';

const COMMIT = 'a'.repeat(40),
  TREE = 'b'.repeat(40),
  CHILD = 'c'.repeat(40),
  BLOB = 'd'.repeat(40);
const repo = {
  owner: 'owner',
  name: 'repository',
  fullName: 'owner/repository',
  commit: COMMIT,
  tree: TREE,
};
const api = 'https://api.github.com/repos/owner/repository';
const raw = `https://raw.githubusercontent.com/owner/repository/${COMMIT}`;
const json = (body, options) => new Response(JSON.stringify(body), options);
const file = (path, size = 3, extra = {}) => ({
  path,
  size,
  sha: BLOB,
  type: 'blob',
  mode: '100644',
  ...extra,
});
const dir = (path, sha = CHILD) => ({ path, sha, type: 'tree', mode: '040000' });
const tree = (entries, sha = TREE, truncated = false) => ({ sha, tree: entries, truncated });
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    assert.ok(Object.hasOwn(routes, url), `Unexpected URL: ${url}`);
    const response = routes[url];
    return typeof response === 'function' ? response(options) : response.clone();
  };
  return { fetchImpl, calls };
}

test('parses canonical public GitHub repository references', () => {
  for (const input of ['owner/repository', ' https://github.com/owner/repository.git/ ']) {
    assert.deepEqual(parseRepository(input), {
      owner: 'owner',
      name: 'repository',
      fullName: 'owner/repository',
    });
  }
});

test('rejects hostile and ambiguous repository URLs before any request', async () => {
  for (const input of [
    null,
    '',
    '../evil',
    'a/b/c',
    '-owner/repo',
    'a/..',
    'a/.git',
    'a/repo?x',
    'http://github.com/a/b',
    'https://github.com.evil.test/a/b',
    'https://github.com@evil.test/a/b',
    'https://u:p@github.com/a/b',
    'https://github.com:443/a/b',
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#readme',
    'https://github.com/a/%2e%2e/b',
    'https://github.com/a/../b',
    'https://github.com/a/b\\c',
    '//github.com/a/b',
    'git@github.com:a/b',
  ]) {
    assert.throws(() => parseRepository(input), { code: 'INVALID_REPOSITORY' }, String(input));
  }
  await assert.rejects(
    resolveRepository('https://evil.test/repo', { fetchImpl: () => assert.fail('must not fetch') }),
    { code: 'INVALID_REPOSITORY' },
  );
});

test('resolves default branch once to immutable commit and tree IDs', async () => {
  const progress = [];
  const network = fakeFetch({
    [api]: json({
      private: false,
      full_name: repo.fullName,
      default_branch: 'main',
      html_url: 'https://evil.test',
    }),
    [`${api}/commits/main`]: json({ sha: COMMIT, commit: { tree: { sha: TREE } } }),
  });
  const result = await resolveRepository(repo.fullName, {
    ...network,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.commit, COMMIT);
  assert.equal(result.tree, TREE);
  assert.equal(result.defaultBranch, 'main');
  assert.equal(result.url, 'https://github.com/owner/repository');
  assert.equal(progress.at(-1).stage, 'resolve');
  assert.equal(progress.at(-1).completed, 2);
});

test('encodes slash-containing refs and never trusts API-provided fetch URLs', async () => {
  const network = fakeFetch({
    [api]: json({ private: false, full_name: repo.fullName, default_branch: 'main' }),
    [`${api}/commits/feature%2Fwork`]: json({
      sha: COMMIT,
      commit: { tree: { sha: TREE, url: 'https://evil.test/tree' } },
    }),
  });
  assert.equal(
    (await resolveRepository(repo.fullName, { ...network, ref: 'feature/work' })).commit,
    COMMIT,
  );
  for (const ref of ['../main', 'main?x=1', 'x#x', 'x\\y', 'https://evil.test', 'a\u0000b']) {
    await assert.rejects(
      resolveRepository(repo.fullName, {
        ref,
        fetchImpl: () => assert.fail('invalid ref must not fetch'),
      }),
      { code: 'INVALID_REF' },
    );
  }
});

test('rejects private repositories, missing visibility, and unpinned commit responses', async () => {
  for (const visibility of [{ private: true }, {}, { private: false, visibility: 'internal' }]) {
    const network = fakeFetch({
      [api]: json({ ...visibility, full_name: repo.fullName, default_branch: 'main' }),
    });
    await assert.rejects(resolveRepository(repo.fullName, network), { code: 'PRIVATE_REPOSITORY' });
  }
  const network = fakeFetch({
    [api]: json({ private: false, full_name: repo.fullName, default_branch: 'main' }),
    [`${api}/commits/main`]: json({ sha: 'main', commit: { tree: { sha: TREE } } }),
  });
  await assert.rejects(resolveRepository(repo.fullName, network), { code: 'INVALID_RESPONSE' });
});

test('reports anonymous rate limits and inaccessible repositories explicitly', async () => {
  let network = fakeFetch({
    [api]: json(
      {},
      { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } },
    ),
  });
  await assert.rejects(
    resolveRepository(repo.fullName, network),
    (error) =>
      error.code === 'GITHUB_RATE_LIMIT' && /anonymous|unauthenticated/i.test(error.message),
  );
  network = fakeFetch({ [api]: json({}, { status: 404 }) });
  await assert.rejects(
    resolveRepository(repo.fullName, network),
    (error) => error.code === 'HTTP_ERROR' && /public|inaccessible/i.test(error.message),
  );
});

test('lists immutable tree, counts skips, and preserves hidden source configuration', async () => {
  const network = fakeFetch({
    [`${api}/git/trees/${TREE}?recursive=1`]: json(
      tree([
        file('src/app.js'),
        file('.github/workflows/test.yml'),
        file('.eslintrc'),
        file('build/generated.js'),
        file('link', 3, { mode: '120000' }),
        { path: 'dep', sha: CHILD, mode: '160000', type: 'commit' },
      ]),
    ),
  });
  const entries = await listRepository(repo, network);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['.eslintrc', '.github/workflows/test.yml', 'src/app.js'],
  );
  assert.equal(entries.skipped, 3);
  assert.deepEqual(entries.skipReasons, { ignored: 1, symlink: 1, submodule: 1 });
});

test('restarts a truncated recursive listing and visits reused subtree IDs at every path', async () => {
  const network = fakeFetch({
    [`${api}/git/trees/${TREE}?recursive=1`]: json(tree([file('partial-only.txt')], TREE, true)),
    [`${api}/git/trees/${TREE}`]: json(tree([file('README.md'), dir('a'), dir('b')])),
    [`${api}/git/trees/${CHILD}`]: json(tree([file('file.js')], CHILD)),
  });
  const entries = await listRepository(repo, network);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['README.md', 'a/file.js', 'b/file.js'],
  );
  assert.equal(new Set(entries.map((e) => e.path)).size, entries.length);
  assert.equal(network.calls.filter((c) => c.url.endsWith(CHILD)).length, 2);
});

test('fails when a non-recursive subtree is truncated instead of publishing partial paths', async () => {
  const network = fakeFetch({
    [`${api}/git/trees/${TREE}?recursive=1`]: json(tree([], TREE, true)),
    [`${api}/git/trees/${TREE}`]: json(tree([file('only.txt')], TREE, true)),
  });
  await assert.rejects(listRepository(repo, network), { code: 'INCOMPLETE_TREE' });
});

test('rejects hostile paths, duplicate paths, malformed tree IDs, and missing sizes', async () => {
  for (const entries of [
    [file('../secret')],
    [file('/absolute')],
    [file('a//b')],
    [file('a\\b')],
    [file('a/./b')],
    [file('x\u0000y')],
    [file('a'), file('a')],
    [file('x', -1)],
    [file('x', undefined, { size: undefined })],
    [file('x', 1, { sha: 'evil' })],
  ]) {
    const network = fakeFetch({ [`${api}/git/trees/${TREE}?recursive=1`]: json(tree(entries)) });
    await assert.rejects(listRepository(repo, network), /path|size|SHA|sha|revision/i);
  }
});

test('enforces path, entry, file, and fallback tree-request limits', async () => {
  for (const limits of [{ maxFiles: 1 }, { maxEntries: 1 }, { maxPathBytes: 2 }, { maxDepth: 1 }]) {
    const network = fakeFetch({
      [`${api}/git/trees/${TREE}?recursive=1`]: json(tree([file('a/x'), file('b/y')])),
    });
    await assert.rejects(listRepository(repo, { ...network, ...limits }), {
      code: 'REPOSITORY_LIMIT',
    });
  }
  const network = fakeFetch({
    [`${api}/git/trees/${TREE}?recursive=1`]: json(tree([], TREE, true)),
    [`${api}/git/trees/${TREE}`]: json(tree([dir('a')])),
  });
  await assert.rejects(listRepository(repo, { ...network, maxTreeRequests: 2 }), {
    code: 'REPOSITORY_LIMIT',
  });
});

test('downloads encoded paths pinned to full commit and preserves exact Unicode, BOM, and newlines', async () => {
  const original = '\ufeffconst café = "👋";\r\n';
  const bytes = new TextEncoder().encode(original).length;
  const entry = file('src/a #%.js', bytes);
  const network = fakeFetch({ [`${raw}/src/a%20%23%25.js`]: new Response(original) });
  const saved = [];
  const result = await downloadRepository(repo, [entry], {
    ...network,
    onFile: async (data) => saved.push(data),
  });
  assert.deepEqual(saved, [{ path: entry.path, text: original, revision: BLOB, bytes }]);
  assert.deepEqual(result, { downloaded: 1, skipped: 0, bytes, skipReasons: {} });
});

test('counts binary, non-UTF8, LFS, ignored, symlink, submodule, and oversize skips', async () => {
  const lfs =
    'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n';
  const entries = [
    file('binary.txt', 3),
    file('bad.txt', 2),
    file('archive.zip', 100),
    file('lfs.txt', lfs.length),
    file('image.png', 3),
    file('node_modules/a.js', 3),
    file('link', 3, { mode: '120000' }),
    { path: 'dep', type: 'commit', mode: '160000', sha: CHILD },
  ];
  const network = fakeFetch({
    [`${raw}/binary.txt`]: new Response(new Uint8Array([0, 1, 2])),
    [`${raw}/bad.txt`]: new Response(new Uint8Array([0xff, 0xff])),
    [`${raw}/lfs.txt`]: new Response(lfs),
  });
  const result = await downloadRepository(repo, entries, {
    ...network,
    maxFileBytes: 200,
    onFile: () => assert.fail('no source expected'),
  });
  // Add a separately declared oversized file without fetching its body.
  const large = await downloadRepository(repo, [file('huge.txt', 201)], {
    ...network,
    maxFileBytes: 200,
    onFile() {},
  });
  assert.equal(large.skipReasons.oversize, 1);
  assert.equal(result.downloaded, 0);
  assert.equal(result.skipped, 8);
  assert.deepEqual(result.skipReasons, {
    binary: 3,
    utf8: 1,
    lfs: 1,
    ignored: 1,
    symlink: 1,
    submodule: 1,
  });
});

test('merges listing skip counts into the completed download result', async () => {
  const entries = Object.assign([], { skipped: 3, skipReasons: { ignored: 2, submodule: 1 } });
  assert.deepEqual(await downloadRepository(repo, entries, { onFile() {} }), {
    downloaded: 0,
    skipped: 3,
    bytes: 0,
    skipReasons: { ignored: 2, submodule: 1 },
  });
});

test('requires successful complete downloads and awaits durable writes', async () => {
  const network = fakeFetch({ [`${raw}/missing.txt`]: new Response('', { status: 404 }) });
  await assert.rejects(
    downloadRepository(repo, [file('missing.txt')], { ...network, onFile() {} }),
    { code: 'HTTP_ERROR' },
  );
  const mismatch = fakeFetch({ [`${raw}/a.txt`]: new Response('short') });
  await assert.rejects(
    downloadRepository(repo, [file('a.txt', 8)], {
      ...mismatch,
      onFile: () => assert.fail('must not store'),
    }),
    { code: 'DOWNLOAD_MISMATCH' },
  );
  const write = fakeFetch({ [`${raw}/a.txt`]: new Response('abc') });
  await assert.rejects(
    downloadRepository(repo, [file('a.txt')], {
      ...write,
      onFile: async () => {
        throw new Error('disk quota exceeded');
      },
    }),
    /disk quota exceeded/,
  );
});

test('fails total-byte quotas before starting source requests', async () => {
  await assert.rejects(
    downloadRepository(repo, [file('a.txt', 8), file('b.txt', 8)], {
      maxTotalBytes: 10,
      onFile() {},
      fetchImpl: () => assert.fail('must not fetch'),
    }),
    { code: 'REPOSITORY_LIMIT' },
  );
});

test('bounds body streams even when Content-Length lies or is absent', async () => {
  let cancelled = false;
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8).fill(97));
          controller.enqueue(new Uint8Array(8).fill(97));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const result = await downloadRepository(repo, [file('a.txt', 8)], {
    fetchImpl,
    maxFileBytes: 10,
    onFile: () => assert.fail('oversize must not store'),
  });
  assert.equal(result.skipReasons.oversize, 1);
  assert.equal(cancelled, true);
});

test('enforces actual cumulative bytes including skipped bodies', async () => {
  const network = fakeFetch({
    [`${raw}/a.txt`]: new Response('12345678'),
    [`${raw}/b.txt`]: new Response('12345678'),
  });
  await assert.rejects(
    downloadRepository(repo, [file('a.txt', 8), file('b.txt', 1)], {
      ...network,
      maxTotalBytes: 10,
      concurrency: 1,
      onFile() {},
    }),
    { code: 'REPOSITORY_LIMIT' },
  );
});

test('bounded concurrency includes onFile writes and never resolves before them', async () => {
  let active = 0,
    maximum = 0,
    writes = 0;
  const network = fakeFetch(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`${raw}/${i}.txt`, new Response('abc')]),
    ),
  );
  const result = await downloadRepository(
    repo,
    Array.from({ length: 8 }, (_, i) => file(`${i}.txt`)),
    {
      ...network,
      concurrency: 2,
      onFile: async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active--;
        writes++;
      },
    },
  );
  assert.equal(result.downloaded, 8);
  assert.equal(writes, 8);
  assert.equal(maximum, 2);
});

test('supports cancellation before requests and during streaming reads', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    resolveRepository(repo.fullName, {
      signal: cancelled.signal,
      fetchImpl: () => assert.fail('must not fetch'),
    }),
    { name: 'AbortError' },
  );
  const running = new AbortController();
  let bodyCancelled = false;
  const promise = downloadRepository(repo, [file('a.txt')], {
    signal: running.signal,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            bodyCancelled = true;
          },
        }),
      ),
    onFile() {},
  });
  setTimeout(() => running.abort(), 5);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(bodyCancelled, true);
});

test('timeouts include stalled response bodies and bounded JSON documents', async () => {
  await assert.rejects(
    resolveRepository(repo.fullName, {
      timeoutMs: 10,
      fetchImpl: async () => new Response(new ReadableStream()),
    }),
    { code: 'REQUEST_TIMEOUT' },
  );
  await assert.rejects(
    resolveRepository(repo.fullName, {
      maxJsonBytes: 8,
      fetchImpl: async () => json({ private: false, default_branch: 'main' }),
    }),
    { code: 'REPOSITORY_LIMIT' },
  );
});

test('oversized recursive trees fall back to bounded subtrees without keeping partial entries', async () => {
  for (const headers of [{}, { 'Content-Length': '2000' }]) {
    const network = fakeFetch({
      [`${api}/git/trees/${TREE}?recursive=1`]: new Response('x'.repeat(2000), { headers }),
      [`${api}/git/trees/${TREE}`]: json(tree([dir('src')])),
      [`${api}/git/trees/${CHILD}`]: json(tree([file('main.js')], CHILD)),
    });
    const result = await listRepository(repo, { ...network, maxJsonBytes: 1000 });
    assert.deepEqual(
      result.map((entry) => entry.path),
      ['src/main.js'],
    );
    assert.equal(result.treeRequests, 3);
  }
});

test('oversized individual subtrees still fail instead of bypassing the metadata cap', async () => {
  const network = fakeFetch({
    [`${api}/git/trees/${TREE}?recursive=1`]: json(tree([], TREE, true)),
    [`${api}/git/trees/${TREE}`]: new Response('x'.repeat(2000)),
  });
  await assert.rejects(listRepository(repo, { ...network, maxJsonBytes: 1000 }), {
    code: 'REPOSITORY_LIMIT',
  });
});

test('retries 429 and 5xx only within bounded attempts and retry-after delay', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    return requests < 3
      ? new Response('', { status: requests === 1 ? 429 : 503, headers: { 'Retry-After': '0' } })
      : json(tree([]));
  };
  assert.equal((await listRepository(repo, { fetchImpl, retryDelayMs: 1, retries: 2 })).length, 0);
  assert.equal(requests, 3);
  requests = 0;
  await assert.rejects(
    listRepository(repo, {
      fetchImpl: async () => {
        requests++;
        return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
      },
      retryDelayMs: 1,
      retries: 2,
    }),
    { code: 'GITHUB_RATE_LIMIT' },
  );
  assert.equal(requests, 1);
});

test('rejects unsafe repository objects and excessive configured limits', async () => {
  for (const bad of [
    { ...repo, owner: '../evil' },
    { ...repo, commit: 'main' },
  ]) {
    await assert.rejects(downloadRepository(bad, [], { onFile() {} }), /repository|commit/i);
  }
  for (const option of [
    { concurrency: 0 },
    { concurrency: 1000 },
    { maxFileBytes: 17 * 1024 * 1024 },
    { maxFiles: Infinity },
  ]) {
    await assert.rejects(
      downloadRepository(repo, [], { ...option, onFile() {} }),
      /limit|concurrency/i,
    );
  }
});

test('does not classify ambiguous .dat source as binary without inspecting bytes', async () => {
  const network = fakeFetch({ [`${raw}/table.dat`]: new Response('1,2\n') });
  let stored;
  const result = await downloadRepository(repo, [file('table.dat', 4)], {
    ...network,
    onFile: (file) => {
      stored = file;
    },
  });
  assert.equal(result.downloaded, 1);
  assert.equal(stored.text, '1,2\n');
});

test('retains a useful rate-limit error with an out-of-range reset header', async () => {
  const network = fakeFetch({
    [api]: new Response('', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999999999999999999999' },
    }),
  });
  await assert.rejects(resolveRepository(repo.fullName, network), { code: 'GITHUB_RATE_LIMIT' });
});

test('cancellation and timeouts terminate fetches even when transport ignores the signal', async () => {
  const controller = new AbortController();
  const promise = listRepository(repo, {
    signal: controller.signal,
    fetchImpl: () => new Promise(() => {}),
  });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(promise, { name: 'AbortError' });
  await assert.rejects(
    listRepository(repo, { timeoutMs: 10, fetchImpl: () => new Promise(() => {}) }),
    { code: 'REQUEST_TIMEOUT' },
  );
});

test('bounds retry attempts and cancels pending retry delays', async () => {
  let requests = 0;
  const controller = new AbortController();
  await assert.rejects(
    listRepository(repo, {
      retries: 2,
      retryDelayMs: 1,
      fetchImpl: async () => {
        requests++;
        return new Response('', { status: 503 });
      },
    }),
    { code: 'HTTP_ERROR' },
  );
  assert.equal(requests, 3);
  const promise = listRepository(repo, {
    signal: controller.signal,
    retryDelayMs: 1000,
    onProgress: (p) => {
      if (p.stage === 'retry') controller.abort();
    },
    fetchImpl: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(promise, { name: 'AbortError' });
});

test('a failed file cancels remaining work and never reports a ready download', async () => {
  let writes = 0,
    progress;
  const network = fakeFetch({
    [`${raw}/fail.txt`]: new Response('', { status: 404 }),
    [`${raw}/pending.txt`]: () => new Response(new ReadableStream()),
  });
  await assert.rejects(
    downloadRepository(repo, [file('fail.txt'), file('pending.txt')], {
      ...network,
      onProgress: (p) => {
        progress = p;
      },
      onFile: () => {
        writes++;
      },
    }),
    { code: 'HTTP_ERROR' },
  );
  assert.equal(writes, 0);
  assert.equal(progress.completed, 0);
});
