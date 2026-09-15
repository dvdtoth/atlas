import { LocalSource } from '../index/local-source.mjs';
import { TEXT_SCALES, tileShape } from './text-detail.mjs';
import {
  TILE_ROWS,
  CELL_WIDTH,
  ROW_HEIGHT,
  LEXICAL_COLORS,
  lexLine,
  layoutLine,
} from './text-layout.mjs';

// Protocol: tile {key,id,display,start,column,scale,revision?}
// => tile {...,bitmap,width,height,revision,lineMap,columnMap,rows,tileRows,columns,elapsed}.
// Cancellation {type:'cancel',keys:[...]}; canceled work produces no reply.
// Optional revision enables exact-revision page reuse. Without it each completed
// request fetches again; only simultaneous reads of the same page are shared.
const PAGE_BYTES = 16 * 1024 * 1024;
const PAGE_COUNT = 128;
const MAX_PENDING = 256;

function abortError() {
  return new DOMException('Tile request canceled', 'AbortError');
}
function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}
function pageKey(request, revision = request.revision) {
  return JSON.stringify([request.id, !!request.display, request.start, revision ?? null]);
}

function validatePage(page, request) {
  if (
    page?.id !== request.id ||
    page.start !== request.start ||
    page.revision == null ||
    !Array.isArray(page.sourceLines) ||
    page.sourceLines.length > TILE_ROWS ||
    !page.sourceLines.every((line) => typeof line === 'string') ||
    !Array.isArray(page.lineMap) ||
    !Array.isArray(page.columnMap) ||
    page.lineMap.length !== page.sourceLines.length ||
    page.columnMap.length !== page.sourceLines.length ||
    !page.lineMap.every((n) => Number.isSafeInteger(n) && n >= 0) ||
    !page.columnMap.every((n) => Number.isSafeInteger(n) && n >= 0)
  ) {
    throw new Error('Invalid source page or mismatched source address');
  }
  return page;
}

export class SourcePageCache {
  constructor({
    fetch: fetcher = globalThis.fetch.bind(globalThis),
    maxPages = PAGE_COUNT,
    maxBytes = PAGE_BYTES,
  } = {}) {
    this.fetch = fetcher;
    this.maxPages = maxPages;
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.pages = new Map();
    this.pending = new Map();
  }

  async get(request, signal) {
    checkAbort(signal);
    const key = pageKey(request);
    const hit = request.revision != null ? this.pages.get(key) : null;
    if (hit) {
      this.pages.delete(key);
      this.pages.set(key, hit);
      return hit.page;
    }
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const controller = new AbortController();
      entry = { controller, users: 0, promise: null };
      const params = new URLSearchParams({
        id: request.id,
        start: request.start,
        count: TILE_ROWS,
        display: request.display ? 1 : 0,
      });
      entry.promise = (async () => {
        const response = await this.fetch(`/api/document?${params}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Source page HTTP ${response.status}`);
        const page = validatePage(await response.json(), request);
        checkAbort(controller.signal);
        this.put(request, page);
        return page;
      })().finally(() => {
        if (this.pending.get(key) === entry) this.pending.delete(key);
      });
      this.pending.set(key, entry);
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', canceled);
        entry.users--;
        if (!entry.users && this.pending.get(key) === entry) entry.controller.abort();
        callback(value);
      };
      const canceled = () => finish(reject, abortError());
      signal?.addEventListener('abort', canceled, { once: true });
      entry.promise.then(
        (page) => finish(resolve, page),
        (error) => finish(reject, error),
      );
      if (signal?.aborted) canceled();
    });
  }

  put(request, page) {
    // Revision changes invalidate every other retained page for this document.
    for (const [key, value] of this.pages) {
      if (value.page.id === page.id && value.page.revision !== page.revision) {
        this.pages.delete(key);
        this.bytes -= value.bytes;
      }
    }
    const key = pageKey(request, page.revision);
    const bytes =
      page.sourceLines.reduce((sum, line) => sum + line.length * 2 + 48, 256) +
      (page.path?.length || 0) * 2;
    const old = this.pages.get(key);
    if (old) {
      this.pages.delete(key);
      this.bytes -= old.bytes;
    }
    if (bytes > this.maxBytes || this.maxPages < 1) return;
    while (this.pages.size >= this.maxPages || this.bytes + bytes > this.maxBytes) {
      const oldest = this.pages.entries().next().value;
      if (!oldest) break;
      this.pages.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    this.pages.set(key, { page, bytes });
    this.bytes += bytes;
  }
}

function validateRequest(request) {
  if (
    typeof request.key !== 'string' ||
    !request.key ||
    !Number.isSafeInteger(request.id) ||
    request.id < 0 ||
    !Number.isSafeInteger(request.start) ||
    request.start < 0 ||
    !Number.isSafeInteger(request.column) ||
    request.column < 0 ||
    request.column > 1_000_000 ||
    !TEXT_SCALES.includes(request.scale)
  ) {
    throw new Error('Invalid tile address or raster scale');
  }
}

/** All source work and rasterization runs on this module worker, never in RAF. */
export async function renderTile(request, signal, pages) {
  const started = performance.now();
  validateRequest(request);
  const { columns, rows: tileRows, width, height } = tileShape(request.scale);
  const pageStart = Math.floor(request.start / TILE_ROWS) * TILE_ROWS;
  const page = await pages.get({ ...request, start: pageStart }, signal);
  checkAbort(signal);
  const first = request.start - pageStart,
    end = Math.min(first + tileRows, page.sourceLines.length);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('OffscreenCanvas 2D rasterization is unavailable');
  // Keep only ink in the cache. The GPU supplies the same live background as
  // the enclosing file, so selecting a file never needs to rerasterize its text.
  context.scale(request.scale, request.scale);
  context.font = '15px Menlo, Consolas, "Liberation Mono", monospace';
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.fontKerning = 'none';
  // Monospace face metrics differ by platform. Normalize ASCII runs to exactly
  // nine world pixels per character, without stretching wider Unicode clusters.
  const asciiAdvance = context.measureText('M').width || CELL_WIDTH;
  let state = { mode: 'normal' };
  for (let row = 0; row < end; row++) {
    checkAbort(signal);
    const continued =
      row + 1 < page.sourceLines.length && page.lineMap[row + 1] === page.lineMap[row];
    const lexical = lexLine(page.sourceLines[row], { path: page.path || '', state, continued });
    state = lexical.state;
    // Replay the preceding rows of the shared page for comment/string state;
    // only rasterize the smaller source region requested for close reading.
    if (row < first) continue;
    const { runs } = layoutLine(page.sourceLines[row], {
      column: request.column,
      count: columns,
      origin: page.columnMap[row],
      tokens: lexical.tokens,
    });
    for (const run of runs) {
      const x = (run.column - request.column) * CELL_WIDTH;
      const y = (row - first) * ROW_HEIGHT + 15;
      context.fillStyle = LEXICAL_COLORS[run.kind];
      if (request.scale === 0.25) {
        // Below readable size, preserve each token's colour and occupied width
        // instead of rasterizing tiny, barely covered glyphs. Whitespace is skipped.
        context.fillRect(x, y - 8, run.cells * CELL_WIDTH, 5);
        continue;
      }
      context.save();
      context.translate(x, y);
      if (run.ascii) context.scale(CELL_WIDTH / asciiAdvance, 1);
      context.fillText(run.text, 0, 0);
      context.restore();
    }
    // Yield between rows so cancellations can interrupt preparation before upload.
    if ((row & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  checkAbort(signal);
  return {
    type: 'tile',
    key: request.key,
    id: request.id,
    display: !!request.display,
    start: request.start,
    column: request.column,
    width,
    height,
    bitmap: canvas.transferToImageBitmap(),
    revision: page.revision,
    lineMap: page.lineMap.slice(first, end),
    columnMap: page.columnMap.slice(first, end),
    rows: Math.max(0, end - first),
    tileRows,
    columns,
    elapsed: performance.now() - started,
  };
}

export function createTileScheduler({ render, postMessage, concurrency = 3 } = {}) {
  const jobs = new Map();
  let queue = [],
    active = 0;
  function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    jobs.delete(key);
    job.controller.abort();
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) continue;
      active++;
      (async () => {
        try {
          const result = await render(job.request, job.controller.signal);
          if (job.controller.signal.aborted) result?.bitmap?.close();
          else postMessage(result, result?.bitmap ? [result.bitmap] : []);
        } catch (error) {
          if (!job.controller.signal.aborted)
            postMessage({
              type: 'tile-error',
              key: job.request.key,
              error: String(error?.message || error),
            });
        } finally {
          active--;
          if (jobs.get(job.request.key) === job) jobs.delete(job.request.key);
          pump();
        }
      })();
    }
  }
  return {
    receive(message) {
      if (message?.type === 'cancel') {
        for (const key of message.keys || []) cancel(key);
        queue = queue.filter((job) => !job.controller.signal.aborted);
        return;
      }
      if (message?.type !== 'tile') return;
      if (jobs.has(message.key)) return;
      if (queue.length >= MAX_PENDING) {
        postMessage({
          type: 'tile-error',
          key: message.key,
          error: 'Tile queue is full; request visible tiles again',
        });
        return;
      }
      const job = { request: message, controller: new AbortController() };
      jobs.set(message.key, job);
      queue.push(job);
      pump();
    },
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const project = new URL(globalThis.location.href).searchParams.get('project');
  const source = project
    ? LocalSource.open(project)
    : Promise.reject(Error('Missing local repository identity'));
  source.catch(() => {});
  const pages = new SourcePageCache({
    fetch: async (url, { signal } = {}) => {
      signal?.throwIfAborted();
      const params = Object.fromEntries(new URL(url, 'https://local.invalid').searchParams);
      const page = await (await source).request('document', params);
      signal?.throwIfAborted();
      return { ok: true, json: async () => page };
    },
  });
  const scheduler = createTileScheduler({
    render: (request, signal) => renderTile(request, signal, pages),
    postMessage: (message, transfer = []) => globalThis.postMessage(message, transfer),
  });
  globalThis.addEventListener('message', (event) => scheduler.receive(event.data));
}
