/** Public GitHub input adapter. Run in a worker; repository contents are data only. */
const MiB = 1024 * 1024;
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 16 * MiB,
  maxTotalBytes: 5 * 1024 * MiB,
  maxFiles: 600_000,
  maxEntries: 800_000,
  maxTreeRequests: 10_000,
  maxPathBytes: 4096,
  maxDepth: 128,
  maxJsonBytes: 16 * MiB,
  concurrency: 4,
  timeoutMs: 30_000,
  retries: 2,
  retryDelayMs: 500,
  maxRetryDelayMs: 10_000,
});

const HARD_LIMITS = {
  maxFileBytes: 16 * MiB,
  maxTotalBytes: 8 * 1024 * MiB,
  maxFiles: 1_000_000,
  maxEntries: 2_000_000,
  maxTreeRequests: 20_000,
  maxPathBytes: 4096,
  maxDepth: 256,
  maxJsonBytes: 32 * MiB,
  concurrency: 8,
  timeoutMs: 120_000,
  retries: 3,
  retryDelayMs: 10_000,
  maxRetryDelayMs: 30_000,
};
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'build',
  'dist',
  'out',
  'target',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
]);
const BINARY_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|zst|woff2?|ttf|otf|eot|mp[34]|m4[av]|mov|avi|mkv|wav|ogg|flac|aac|aiff|wasm|o|a|so|dylib|dll|exe|class|pyc|pyo|jar|db|sqlite3?|bin|dmg|iso|pack|psd|sketch|blend|glb|npy|npz|parquet|arrow)$/i;
const encoder = new TextEncoder();

export class GitHubImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubImportError';
    this.code = code;
    Object.assign(this, details);
  }
}
function fail(code, message, details) {
  throw new GitHubImportError(code, message, details);
}
function limitsFrom(options) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) limits[key] = options[key];
    const minimum = key === 'retries' || key === 'retryDelayMs' ? 0 : 1;
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < minimum ||
      limits[key] > HARD_LIMITS[key]
    ) {
      fail(
        'INVALID_LIMIT',
        `Invalid ${key} limit; expected an integer from ${minimum} to ${HARD_LIMITS[key]}.`,
      );
    }
  }
  return limits;
}
function abortError() {
  return new DOMException('Repository import cancelled.', 'AbortError');
}
function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}
function report(callback, stage, message, details = {}) {
  callback?.({ stage, message, completed: 0, total: 0, bytes: 0, ...details });
}
function assertSHA(value, label = 'revision') {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value))
    fail(
      'INVALID_RESPONSE',
      `GitHub returned an invalid ${label} SHA; immutable revisions are required.`,
    );
  return value.toLowerCase();
}

/** Accept owner/repo or a canonical HTTPS github.com repository URL, optionally .git. */
export function parseRepository(input) {
  if (typeof input !== 'string')
    fail(
      'INVALID_REPOSITORY',
      'Enter a public GitHub repository as owner/repo or its canonical HTTPS URL.',
    );
  let value = input.trim();
  if (value.startsWith('https://')) {
    // Match the original input, before URL's dot-segment/port/backslash normalization.
    const match = /^https:\/\/github\.com\/([^/?#\\]+)\/([^/?#\\]+)\/?$/.exec(value);
    if (!match)
      fail(
        'INVALID_REPOSITORY',
        'Use a canonical https://github.com/owner/repo repository URL without credentials, port, query, fragment, or extra path.',
      );
    value = `${match[1]}/${match[2]}`;
  }
  const parts = value.split('/');
  if (parts.length !== 2) fail('INVALID_REPOSITORY', 'Enter a GitHub repository as owner/repo.');
  const owner = parts[0],
    name = parts[1].replace(/\.git$/, '');
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner) ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    fail('INVALID_REPOSITORY', 'The GitHub repository owner or name is invalid.');
  }
  return { owner, name, fullName: `${owner}/${name}` };
}
function validateRef(ref) {
  if (
    typeof ref !== 'string' ||
    !ref ||
    ref.length > 1024 ||
    /[\s\x00-\x1f\x7f~^:?*\[\\#%]/.test(ref) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref.includes('//') ||
    ref === '@' ||
    ref
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  ) {
    fail('INVALID_REF', 'Enter a valid Git branch, tag, or commit reference.');
  }
  try {
    encodeURIComponent(ref);
  } catch {
    fail('INVALID_REF', 'The Git reference contains invalid Unicode.');
  }
  return ref;
}
function pinnedRepo(repo, requireTree = false) {
  if (!repo || typeof repo.owner !== 'string' || typeof repo.name !== 'string')
    fail('INVALID_REPOSITORY', 'A resolved GitHub repository is required.');
  const parsed = parseRepository(`${repo.owner}/${repo.name}`);
  if (parsed.name !== repo.name || parsed.owner !== repo.owner)
    fail('INVALID_REPOSITORY', 'Invalid resolved GitHub repository name.');
  const result = { ...parsed, commit: assertSHA(repo.commit, 'commit') };
  if (requireTree) result.tree = assertSHA(repo.tree, 'tree');
  return result;
}
function apiURL(repo) {
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function abortable(promise, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
function pause(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function httpError(response) {
  const status = response.status;
  if (
    status === 429 ||
    (status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after')))
  ) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const resetDate = new Date(reset * 1000);
    const resetMessage =
      reset > 0 && Number.isFinite(resetDate.getTime())
        ? ` The API limit resets at ${resetDate.toISOString()}.`
        : '';
    return new GitHubImportError(
      'GITHUB_RATE_LIMIT',
      `GitHub's anonymous API rate limit was reached.${resetMessage} Try later or import a local folder.`,
      { status },
    );
  }
  const help =
    status === 404
      ? ' The public repository, reference, or expected file is inaccessible or no longer exists.'
      : status === 403
        ? ' GitHub denied this public request; an anonymous rate limit may apply. Try later or import a local folder.'
        : status === 409
          ? ' The repository may be empty or the requested revision unavailable.'
          : '';
  return new GitHubImportError('HTTP_ERROR', `GitHub request failed (HTTP ${status}).${help}`, {
    status,
  });
}
function retryDelay(response, attempt, limits) {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return limits.retryDelayMs * 2 ** attempt;
}

async function readBounded(response, limit, code, signal, onBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    response.body?.cancel().catch(() => {});
    fail(code, `Response exceeds the ${limit}-byte limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0,
    complete = false;
  try {
    for (;;) {
      checkAbort(signal);
      const { value, done } = await abortable(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      onBytes?.(value.byteLength);
      if (size > limit) fail(code, `Response exceeds the ${limit}-byte limit.`);
      chunks.push(value);
    }
  } finally {
    // Do not let an uncooperative response stream delay cancellation or failure.
    if (!complete) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function requestBytes(
  url,
  options,
  limits,
  byteLimit,
  oversizeCode = 'REPOSITORY_LIMIT',
  onBytes,
) {
  const { signal, onProgress, fetchImpl = globalThis.fetch } = options;
  if (typeof fetchImpl !== 'function')
    fail('NETWORK_ERROR', 'This browser does not support repository downloads.');
  for (let attempt = 0; attempt <= limits.retries; attempt++) {
    checkAbort(signal);
    const controller = new AbortController();
    const externalAbort = () =>
      controller.abort(signal.reason instanceof Error ? signal.reason : abortError());
    signal?.addEventListener('abort', externalAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new GitHubImportError(
            'REQUEST_TIMEOUT',
            `GitHub request timed out after ${limits.timeoutMs} ms. Try again or import a local folder.`,
          ),
        ),
      limits.timeoutMs,
    );
    let retryMs;
    try {
      const response = await abortable(
        fetchImpl(url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: url.startsWith('https://api.github.com/')
            ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            : {},
        }),
        controller.signal,
      );
      if (!response.ok) {
        const error = httpError(response);
        response.body?.cancel().catch(() => {});
        const delay = retryDelay(response, attempt, limits);
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < limits.retries &&
          delay <= limits.maxRetryDelayMs
        )
          retryMs = delay;
        else throw error;
      } else {
        return await readBounded(response, byteLimit, oversizeCode, controller.signal, onBytes);
      }
    } catch (error) {
      checkAbort(controller.signal);
      if (error instanceof GitHubImportError || error?.name === 'AbortError') throw error;
      throw new GitHubImportError(
        'NETWORK_ERROR',
        'GitHub could not be reached. Check your connection and browser access, or import a local folder.',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', externalAbort);
    }
    report(onProgress, 'retry', `Retrying GitHub request (${attempt + 1}/${limits.retries}).`, {
      attempt: attempt + 1,
      retryMs,
    });
    await pause(retryMs, signal);
  }
}
async function requestJSON(url, options, limits, oversizeCode = 'REPOSITORY_LIMIT') {
  const bytes = await requestBytes(url, options, limits, limits.maxJsonBytes, oversizeCode);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('INVALID_RESPONSE', 'GitHub returned an invalid JSON response.');
  }
}

/** Resolve public metadata and exactly one immutable commit before tree or source reads. */
export async function resolveRepository(input, options = {}) {
  const parsed = parseRepository(input);
  const limits = limitsFrom(options);
  const ref = options.ref === undefined || options.ref === '' ? '' : validateRef(options.ref);
  checkAbort(options.signal);
  report(options.onProgress, 'resolve', 'Checking public GitHub repository.', { total: 2 });
  const metadata = await requestJSON(apiURL(parsed), options, limits);
  if (
    metadata?.private !== false ||
    (metadata.visibility !== undefined && metadata.visibility !== 'public')
  )
    fail(
      'PRIVATE_REPOSITORY',
      'Only public GitHub repositories can be imported. Use a local folder for other source.',
    );
  const canonical = parseRepository(metadata.full_name);
  const defaultBranch = validateRef(metadata.default_branch);
  report(options.onProgress, 'resolve', 'Resolving an immutable commit.', {
    completed: 1,
    total: 2,
  });
  const chosenRef = ref || defaultBranch;
  const data = await requestJSON(
    `${apiURL(canonical)}/commits/${encodeURIComponent(chosenRef)}`,
    options,
    limits,
  );
  const commit = assertSHA(data?.sha, 'commit');
  const tree = assertSHA(data?.commit?.tree?.sha, 'tree');
  report(options.onProgress, 'resolve', `Resolved commit ${commit.slice(0, 12)}.`, {
    completed: 2,
    total: 2,
  });
  return {
    ...canonical,
    commit,
    tree,
    defaultBranch,
    ref: chosenRef,
    url: `https://github.com/${canonical.fullName}`,
  };
}

function validPath(path, limits, singleComponent = false) {
  if (typeof path !== 'string' || !path || /[\\\x00-\x1f\x7f-\x9f]/.test(path))
    fail('INVALID_PATH', 'GitHub returned an unsafe source path.');
  const segments = path.split('/');
  if (
    segments.some((part) => !part || part === '.' || part === '..') ||
    (singleComponent && segments.length !== 1)
  )
    fail('INVALID_PATH', 'GitHub returned an unsafe source path.');
  try {
    encodeURIComponent(path);
  } catch {
    fail('INVALID_PATH', 'GitHub returned a source path with invalid Unicode.');
  }
  if (
    encoder.encode(path).byteLength > limits.maxPathBytes ||
    segments.length > limits.maxDepth ||
    segments.some((part) => encoder.encode(part).byteLength > 255)
  ) {
    fail(
      'REPOSITORY_LIMIT',
      'Repository source path exceeds the configured path length or depth limit.',
    );
  }
  return segments;
}
function classifyEntry(entry, limits, singleComponent = false) {
  if (!entry || typeof entry !== 'object')
    fail('INVALID_RESPONSE', 'GitHub returned an invalid tree entry.');
  validPath(entry.path, limits, singleComponent);
  assertSHA(entry.sha, 'blob/tree');
  if (entry.type === 'tree' && entry.mode === '040000') return 'tree';
  if (entry.type === 'commit' && entry.mode === '160000') return 'submodule';
  if (entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode))
    fail('INVALID_RESPONSE', 'GitHub returned an unsupported tree entry type or mode.');
  if (!Number.isSafeInteger(entry.size) || entry.size < 0)
    fail('INVALID_RESPONSE', 'GitHub returned an invalid or missing blob size.');
  return entry.mode === '120000' ? 'symlink' : 'blob';
}
function ignoredPath(path) {
  return path
    .split('/')
    .slice(0, -1)
    .some((part) => IGNORED_DIRECTORIES.has(part));
}
function increment(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}
function validateTree(data, sha) {
  if (
    !data ||
    !Array.isArray(data.tree) ||
    typeof data.truncated !== 'boolean' ||
    assertSHA(data.sha, 'tree') !== sha
  )
    fail('INVALID_RESPONSE', 'GitHub returned a missing, malformed, or mismatched tree.');
}

/**
 * Returns regular blobs, sorted by exact path. Array metadata .skipped/.skipReasons
 * counts all excluded files; ignored subtrees are still enumerated for exact counts.
 * Truncated recursive results are discarded before bounded non-recursive traversal.
 */
export async function listRepository(repo, options = {}) {
  const source = pinnedRepo(repo, true),
    limits = limitsFrom(options);
  checkAbort(options.signal);
  const entries = [],
    paths = new Set(),
    skipReasons = {};
  let filesSeen = 0,
    requests = 0,
    skipped = 0;
  async function getTree(sha, recursive = false) {
    checkAbort(options.signal);
    if (++requests > limits.maxTreeRequests)
      fail(
        'REPOSITORY_LIMIT',
        'Repository listing exceeds the configured tree-request limit. Import a local folder or increase the limit.',
      );
    report(options.onProgress, 'list', 'Listing repository paths.', {
      completed: paths.size,
      files: filesSeen,
      treeRequests: requests,
      skipped,
    });
    const data = await requestJSON(
      `${apiURL(source)}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
      options,
      limits,
      recursive ? 'RECURSIVE_TREE_TOO_LARGE' : 'REPOSITORY_LIMIT',
    );
    validateTree(data, sha);
    return data;
  }
  function addEntry(entry, prefix = '', direct = false) {
    checkAbort(options.signal);
    const kind = classifyEntry(entry, limits, direct);
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    validPath(path, limits);
    if (paths.has(path)) fail('INVALID_RESPONSE', 'GitHub returned a duplicate repository path.');
    paths.add(path);
    if (paths.size > limits.maxEntries)
      fail('REPOSITORY_LIMIT', 'Repository listing exceeds the configured entry limit.');
    if (kind === 'tree') return { path, sha: entry.sha.toLowerCase() };
    if (++filesSeen > limits.maxFiles)
      fail('REPOSITORY_LIMIT', 'Repository listing exceeds the configured file limit.');
    const reason = kind === 'blob' ? (ignoredPath(path) ? 'ignored' : null) : kind;
    if (reason) {
      skipped++;
      increment(skipReasons, reason);
    } else
      entries.push({
        path,
        sha: entry.sha.toLowerCase(),
        size: entry.size,
        mode: entry.mode,
        type: 'blob',
      });
    return null;
  }
  let recursive;
  try {
    recursive = await getTree(source.tree, true);
  } catch (error) {
    if (error.code !== 'RECURSIVE_TREE_TOO_LARGE') throw error;
  }
  if (recursive && !recursive.truncated) {
    for (const entry of recursive.tree) addEntry(entry);
  } else {
    report(
      options.onProgress,
      'list',
      'The recursive tree is too large or truncated; enumerating complete subtrees.',
    );
    const pending = [{ path: '', sha: source.tree, ancestors: [] }];
    while (pending.length) {
      const current = pending.pop();
      if (current.ancestors.includes(current.sha))
        fail('INVALID_RESPONSE', 'GitHub returned a cyclic tree.');
      const data = await getTree(current.sha);
      if (data.truncated)
        fail(
          'INCOMPLETE_TREE',
          'GitHub truncated a non-recursive subtree. A complete import is unavailable; import a local folder.',
        );
      for (const item of data.tree) {
        const child = addEntry(item, current.path, true);
        if (child) pending.push({ ...child, ancestors: [...current.ancestors, current.sha] });
      }
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  Object.assign(entries, { skipped, skipReasons, filesSeen, treeRequests: requests });
  report(
    options.onProgress,
    'list',
    `Listed ${entries.length} source candidates; ${skipped} excluded files.`,
    {
      completed: paths.size,
      total: paths.size,
      files: entries.length,
      skipped,
      skipReasons: { ...skipReasons },
    },
  );
  return entries;
}

function contentSkip(bytes) {
  for (const byte of bytes)
    if (
      byte === 0 ||
      byte < 9 ||
      (byte > 10 && byte < 12) ||
      (byte > 13 && byte < 32) ||
      byte === 127
    )
      return { reason: 'binary' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { reason: 'utf8' };
  }
  if (/^(?:\ufeff)?version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text))
    return { reason: 'lfs' };
  return { text };
}

/**
 * Await onFile({path,text,revision,bytes}) for each exact UTF-8 source. Work and
 * durable writes share bounded concurrency. bytes includes downloaded skipped
 * bodies; a missing expected file, quota failure, or write error rejects the import.
 */
export async function downloadRepository(repo, entries, options = {}) {
  const source = pinnedRepo(repo),
    limits = limitsFrom(options);
  checkAbort(options.signal);
  if (!Array.isArray(entries))
    fail('INVALID_RESPONSE', 'A complete repository entry array is required.');
  if (typeof options.onFile !== 'function')
    fail('INVALID_OPTION', 'An onFile callback is required to store downloaded source.');
  const inheritedReasons = entries.skipReasons || {};
  if (!Object.values(inheritedReasons).every((value) => Number.isSafeInteger(value) && value >= 0))
    fail('INVALID_RESPONSE', 'Invalid listing skip counts.');
  const skipReasons = { ...inheritedReasons };
  let skipped = Object.values(skipReasons).reduce((sum, value) => sum + value, 0);
  if (
    (entries.skipped !== undefined && skipped !== entries.skipped) ||
    entries.length + skipped > limits.maxFiles
  )
    fail(
      'REPOSITORY_LIMIT',
      'Repository exceeds the file limit or listing skip counts are inconsistent.',
    );
  let bytes = 0,
    downloaded = 0,
    completed = skipped,
    estimatedBytes = 0;
  const candidates = [],
    paths = new Set();
  for (const entry of entries) {
    checkAbort(options.signal);
    const kind = classifyEntry(entry, limits);
    if (paths.has(entry.path)) fail('INVALID_RESPONSE', 'Duplicate source path in download list.');
    paths.add(entry.path);
    if (kind === 'tree')
      fail('INVALID_RESPONSE', 'A file download list must not contain directories.');
    const reason =
      kind !== 'blob'
        ? kind
        : ignoredPath(entry.path)
          ? 'ignored'
          : entry.size > limits.maxFileBytes
            ? 'oversize'
            : BINARY_EXTENSION.test(entry.path)
              ? 'binary'
              : null;
    if (reason) {
      skipped++;
      completed++;
      increment(skipReasons, reason);
      continue;
    }
    estimatedBytes += entry.size;
    if (estimatedBytes > limits.maxTotalBytes)
      fail(
        'REPOSITORY_LIMIT',
        'Repository source exceeds the configured total byte limit. Import a smaller scope or increase the limit.',
      );
    candidates.push(entry);
  }
  const total = candidates.length + skipped;
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(options.signal.reason instanceof Error ? options.signal.reason : abortError());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const requestOptions = { ...options, signal: controller.signal };
  let cursor = 0,
    firstError;
  function progress(message) {
    report(options.onProgress, 'download', message, {
      completed,
      total,
      bytes,
      downloaded,
      skipped,
      skipReasons: { ...skipReasons },
    });
  }
  function countBytes(count) {
    bytes += count;
    if (bytes > limits.maxTotalBytes)
      fail(
        'REPOSITORY_LIMIT',
        'Downloaded source exceeds the configured total byte limit. The import is incomplete.',
      );
  }
  async function worker() {
    try {
      for (;;) {
        checkAbort(controller.signal);
        const index = cursor++;
        if (index >= candidates.length) return;
        const entry = candidates[index];
        const url = `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}/${source.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
        let data;
        try {
          data = await requestBytes(
            url,
            requestOptions,
            limits,
            limits.maxFileBytes,
            'FILE_TOO_LARGE',
            countBytes,
          );
        } catch (error) {
          if (error.code !== 'FILE_TOO_LARGE') throw error;
          skipped++;
          completed++;
          increment(skipReasons, 'oversize');
          progress(`Skipped oversized file: ${entry.path}`);
          continue;
        }
        checkAbort(controller.signal);
        if (data.byteLength !== entry.size)
          fail(
            'DOWNLOAD_MISMATCH',
            `Downloaded byte length does not match the pinned Git blob for ${entry.path}. The import is incomplete.`,
          );
        const content = contentSkip(data);
        if (content.reason) {
          skipped++;
          increment(skipReasons, content.reason);
        } else {
          await options.onFile({
            path: entry.path,
            text: content.text,
            revision: entry.sha.toLowerCase(),
            bytes: data.byteLength,
          });
          checkAbort(controller.signal);
          downloaded++;
        }
        completed++;
        progress(`Processed ${completed} of ${total} files.`);
      }
    } catch (error) {
      if (!firstError) {
        firstError = error;
        controller.abort(error);
      }
    }
  }
  try {
    progress('Downloading immutable source files.');
    await Promise.all(
      Array.from({ length: Math.min(limits.concurrency, candidates.length) }, worker),
    );
    if (firstError) throw firstError;
    checkAbort(controller.signal);
    progress(`Downloaded ${downloaded} text files; skipped ${skipped} files.`);
    return { downloaded, skipped, bytes, skipReasons };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
