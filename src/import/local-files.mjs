import { OrderedImportQueue, importWorkerCount } from './import-queue.mjs';
export const IGNORED = new Set([
  '.git',
  'node_modules',
  'target',
  '.build',
  'build',
  'out',
  'dist',
  '__pycache__',
  '.venv',
  'venv',
]);
export function localPath(file) {
  const path = (file.webkitRelativePath || file.name || '')
    .split('/')
    .slice(file.webkitRelativePath ? 1 : 0)
    .join('/');
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((p) => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f]/.test(p))
  )
    throw Error('Invalid local file path');
  return path;
}
export async function importFolderFiles(
  files,
  {
    signal,
    onProgress = () => {},
    onFile,
    maxBytes = 5 * 1024 ** 3,
    maxFileBytes = 16 * 1024 ** 2,
    readConcurrency = importWorkerCount(globalThis.navigator || {}),
    maxReadBytes = 32 * 1024 ** 2,
  } = {},
) {
  if (files.length > 600000)
    throw Error('This folder exceeds the 600,000-file browser import limit.');
  const seen = new Set(),
    report = { downloaded: 0, skipped: 0, bytes: 0, skipReasons: {} };
  const skip = (reason) => {
    report.skipped++;
    report.skipReasons[reason] = (report.skipReasons[reason] || 0) + 1;
  };
  const ordered = Array.from(files)
    .map((file) => ({ file, path: localPath(file) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  let admittedBytes = 0;
  const queue = new OrderedImportQueue({
    concurrency: readConcurrency,
    maxBytes: maxReadBytes,
    signal,
    process: async ({ file, path }) => {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      signal?.throwIfAborted();
      if (bytes.byteLength !== file.size) throw Error('Local file changed size while importing.');
      if (bytes.includes(0)) return { bytes: bytes.byteLength, skip: 'binary' };
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { bytes: bytes.byteLength, skip: 'encoding' };
      }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) =>
        n.toString(16).padStart(2, '0'),
      ).join('');
      signal?.throwIfAborted();
      return { path, text, revision: hash, bytes: bytes.byteLength };
    },
    consume: async (result) => {
      report.bytes += result.bytes;
      if (result.skip) skip(result.skip);
      else {
        await onFile(result);
        report.downloaded++;
      }
      onProgress({
        stage: 'reading',
        completed: report.downloaded + report.skipped,
        total: files.length,
        bytes: report.bytes,
        message: 'Reading files from your device…',
      });
    },
  });
  try {
    for (const { file, path } of ordered) {
      signal?.throwIfAborted();
      if (seen.has(path)) throw Error('Duplicate path in local folder');
      seen.add(path);
      if (
        path
          .split('/')
          .slice(0, -1)
          .some((p) => IGNORED.has(p))
      ) {
        skip('ignored');
        continue;
      }
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw Error('Invalid local file size');
      if (file.size > maxFileBytes) {
        skip('oversize');
        continue;
      }
      admittedBytes += file.size;
      if (admittedBytes > maxBytes)
        throw Error('This folder exceeds the 5 GiB browser import budget.');
      await queue.submit({ file, path, bytes: file.size });
    }
    await queue.finish();
    return report;
  } catch (error) {
    queue.cancel(error);
    await queue.finish().catch(() => {});
    throw error;
  }
}
