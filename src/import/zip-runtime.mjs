// Safari retains native ZIP stream pipelines during large imports. Keep the
// workaround inside this lazily loaded module; Chromium uses its original path.
const ua = globalThis.navigator?.userAgent || '';
const portable = /AppleWebKit\//.test(ua) && !/(?:Chrome|Chromium|Edg|OPR)\//.test(ua);
const zip = await import(portable ? '../../vendor/zip-portable.mjs' : '../../vendor/zip.mjs');
export const { ZipReader, Reader } = zip;
export const WritableStream = portable
  ? (await import('../../vendor/streams.mjs')).WritableStream
  : globalThis.WritableStream;
export const zipStreamOptions = { useWebWorkers: false, useCompressionStream: !portable };
