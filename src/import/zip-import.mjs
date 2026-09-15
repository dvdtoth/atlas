import { ZipReader } from '../../vendor/zip.mjs';
import { CachedZipReader } from './zip-reader.mjs';
import { importFolderFiles, IGNORED } from './local-files.mjs';

// Called only in the project worker. Keep compressed bytes in the original Blob;
// feed each expanded entry into the bounded parser queue. No filesystem writes.
export async function importZipFiles(
  archive,
  {
    signal,
    onProgress = () => {},
    onFile,
    maxArchiveBytes = 2 * 1024 ** 3,
    maxBytes = 5 * 1024 ** 3,
    maxFileBytes = 16 * 1024 ** 2,
    maxEntries = 600_000,
  } = {},
) {
  signal?.throwIfAborted();
  if (!(archive instanceof Blob)) throw Error('Choose a repository ZIP file.');
  if (archive.size > maxArchiveBytes)
    throw Error('This ZIP exceeds the 2 GiB compressed-file limit.');
  const compressed = new CachedZipReader(archive, { signal });
  const reader = new ZipReader(compressed, {
    useWebWorkers: false,
    strictness: 'strict',
    checkCrc32: true,
    checkOverlappingEntry: true,
  });
  const entries = [],
    seen = new Set(),
    skips = {};
  let count = 0,
    expanded = 0,
    root;
  const skip = (reason) => {
    skips[reason] = (skips[reason] || 0) + 1;
  };
  try {
    onProgress({ stage: 'archive', message: 'Reading the ZIP directory on your device…' });
    for await (const entry of reader.getEntriesGenerator()) {
      signal?.throwIfAborted();
      if (++count > maxEntries) throw Error('This ZIP exceeds the browser entry-count limit.');
      const path = entry.filename.replace(/\/$/, '');
      if (
        !path ||
        path.length > 4096 ||
        path.includes('\\') ||
        path.split('/').some((p) => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f]/.test(p))
      )
        throw Error('Invalid path in ZIP file.');
      if (seen.has(path)) throw Error('Duplicate path in ZIP file.');
      seen.add(path);
      if (entry.directory) continue;
      if (path.split('/').includes('__MACOSX') || path.split('/').pop() === '.DS_Store') {
        skip('metadata');
        continue;
      }
      // Determine the archive's one common wrapper folder, without flattening subfolders.
      const prefix = path.includes('/') ? path.split('/')[0] : null;
      root = root === undefined ? prefix : root === prefix ? root : null;
      if (entry.symlink) {
        skip('symlink');
        continue;
      }
      const kind = (entry.unixMode || 0) & 0o170000;
      if (kind && kind !== 0o100000) {
        skip('special');
        continue;
      }
      if (entry.encrypted)
        throw Error(
          'Encrypted ZIP files are not supported. Choose an unencrypted repository archive.',
        );
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0)
        throw Error('Invalid expanded size in ZIP file.');
      entries.push(entry);
      if (count % 1000 === 0)
        onProgress({ stage: 'archive', message: `Found ${count.toLocaleString()} ZIP entries…` });
    }
    const files = entries.map((entry) => {
      const path = root ? entry.filename.slice(root.length + 1) : entry.filename;
      const ignored = path
        .split('/')
        .slice(0, -1)
        .some((p) => IGNORED.has(p));
      if (!ignored && entry.uncompressedSize <= maxFileBytes) {
        expanded += entry.uncompressedSize;
        if (expanded > maxBytes)
          throw Error('This ZIP exceeds the expanded source import budget (5 GiB).');
      }
      return {
        name: path,
        size: entry.uncompressedSize,
        async arrayBuffer() {
          signal?.throwIfAborted();
          let length = 0;
          const chunks = [];
          // Enforce actual streamed bytes too: never trust the declared ZIP entry size.
          const output = new WritableStream({
            write(chunk) {
              signal?.throwIfAborted();
              length += chunk.byteLength;
              if (length > maxFileBytes || length > entry.uncompressedSize)
                throw Error('ZIP entry exceeded its expanded size limit.');
              chunks.push(chunk.slice());
            },
          });
          onProgress({
            stage: 'unpacking',
            message: 'Unpacking and indexing source on your device…',
          });
          await entry.getData(output, { signal, useWebWorkers: false });
          signal?.throwIfAborted();
          if (length !== entry.uncompressedSize)
            throw Error('ZIP entry has an inconsistent expanded size.');
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytes.buffer;
        },
      };
    });
    const report = await importFolderFiles(files, {
      signal,
      onProgress,
      onFile,
      maxBytes,
      maxFileBytes,
    });
    signal?.throwIfAborted();
    for (const [reason, n] of Object.entries(skips)) {
      report.skipped += n;
      report.skipReasons[reason] = (report.skipReasons[reason] || 0) + n;
    }
    return report;
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw Error(`Could not import ZIP: ${error.message || error}`, { cause: error });
  } finally {
    compressed.close();
    await reader.close();
  }
}
