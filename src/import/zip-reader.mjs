import { Reader } from '../../vendor/zip.mjs';

// ZIP headers and small bodies share pages instead of making separate Blob IO
// round trips. Only compressed bytes are cached; zip.js still validates entries.
export class CachedZipReader extends Reader {
  constructor(blob, { signal, pageBytes = 2 * 1024 ** 2, maxPages = 4 } = {}) {
    super();
    if (
      !Number.isSafeInteger(pageBytes) ||
      pageBytes < 1 ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1
    )
      throw Error('Invalid ZIP read cache budget');
    this.blob = blob;
    this.size = blob.size;
    this.signal = signal;
    this.pageBytes = pageBytes;
    this.maxPages = maxPages;
    this.pages = new Map();
    this.pending = Promise.resolve();
    this.closed = false;
  }
  check() {
    this.signal?.throwIfAborted();
    if (this.closed) throw Error('ZIP reader is closed');
  }
  close() {
    this.closed = true;
    this.pages.clear();
  }
  readUint8Array(offset, length) {
    // Serialize cache misses so parallel range requests cannot overfill the cache.
    const result = this.pending.then(async () => {
      this.check();
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        throw Error('Invalid ZIP byte range');
      const count = Math.max(0, Math.min(length, this.size - offset)),
        output = new Uint8Array(count);
      for (let written = 0; written < count;) {
        this.check();
        const position = offset + written,
          page = Math.floor(position / this.pageBytes),
          start = page * this.pageBytes;
        let bytes = this.pages.get(page);
        if (bytes) this.pages.delete(page);
        else {
          while (this.pages.size >= this.maxPages)
            this.pages.delete(this.pages.keys().next().value);
          const end = Math.min(this.size, start + this.pageBytes);
          bytes = new Uint8Array(await this.blob.slice(start, end).arrayBuffer());
          this.check();
          if (bytes.length !== end - start) throw Error('Incomplete ZIP byte range');
        }
        this.pages.set(page, bytes);
        const first = position - start,
          take = Math.min(count - written, bytes.length - first);
        output.set(bytes.subarray(first, first + take), written);
        written += take;
      }
      return output;
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
