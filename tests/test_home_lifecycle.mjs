import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientStore } from '../src/index/client-store.mjs';

const tick = () => new Promise(setImmediate);
async function until(predicate) {
  for (let i = 0; i < 40 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'expected lifecycle transition did not occur');
}
async function settle() {
  for (let i = 0; i < 5; i++) await tick();
}

async function homeHarness(t) {
  const elements = new Map(),
    workers = [],
    intervals = new Map(),
    navigations = [];
  let now = 0,
    nextInterval = 0;
  const element = () => ({
    value: 'owner/repo',
    disabled: false,
    hidden: false,
    textContent: '',
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    replaceChildren() {},
    append() {},
    focus() {},
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let holdNextEstimate = false,
    releaseRefresh = null,
    onPost = () => {},
    startError = null;
  const globals = {
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      createElement: element,
      createElementNS: element,
      createDocumentFragment: element,
    },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    location: {
      hostname: 'localhost',
      assign(url) {
        navigations.push(url);
      },
    },
    performance: { now: () => now },
    setInterval: (fn) => {
      intervals.set(++nextInterval, fn);
      return nextInterval;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame: (fn) => queueMicrotask(fn),
    navigator: {
      gpu: {},
      storage: {
        estimate: () => {
          if (holdNextEstimate) {
            holdNextEstimate = false;
            return new Promise((resolve) => {
              releaseRefresh = () => resolve({});
            });
          }
          return Promise.resolve({});
        },
      },
    },
    Worker: class {
      constructor() {
        if (startError) throw startError;
        this.index = workers.length;
        this.posts = [];
        this.terminated = false;
        workers.push(this);
      }
      terminate() {
        this.terminated = true;
      }
      postMessage(message) {
        if (!this.terminated) {
          this.posts.push(message);
          onPost(this, message);
        }
      }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  t.mock.method(ClientStore, 'open', async () => ({
    projects: async () => [],
    project: async () => undefined,
  }));
  await import(new URL(`../src/ui/home.mjs?lifecycle=${crypto.randomUUID()}`, import.meta.url));
  await settle();
  return {
    get,
    workers,
    intervals,
    navigations,
    advance(ms) {
      now += ms;
      for (const fn of intervals.values()) fn();
    },
    respond(type, value) {
      const worker = workers.at(-1),
        id = worker.posts.at(-1).id;
      worker.onmessage({ data: { type, id, value } });
    },
    submit: () => get('import-form').onsubmit({ preventDefault() {} }),
    cancel: () => get('cancel-import').onclick(),
    holdRefresh() {
      holdNextEstimate = true;
      releaseRefresh = null;
    },
    get refreshHeld() {
      return !!releaseRefresh;
    },
    releaseRefresh() {
      releaseRefresh();
    },
    failWorkerStart() {
      startError = Error('Worker startup blocked');
    },
    set onPost(callback) {
      onPost = callback;
    },
    error(worker, message) {
      queueMicrotask(() =>
        worker.onmessage({ data: { type: 'error', id: message.id, error: 'Import failed' } }),
      );
    },
  };
}

test('cancelling with a background library refresh outstanding settles the active import', async (t) => {
  const home = await homeHarness(t);
  home.holdRefresh();
  home.submit();
  await until(() => home.refreshHeld);
  await home.cancel();
  assert.equal(home.workers[0].terminated, true);
  home.releaseRefresh();
  await until(() => !home.get('import-button').disabled);
  await settle();
  assert.equal(home.workers[0].posts.length, 1);
  assert.equal(home.get('progress-panel').hidden, true);
  assert.equal(home.get('import-error').hidden, true);
});

test('finishing a failed import cannot close or forget a newly started import', async (t) => {
  const home = await homeHarness(t);
  home.onPost = (worker, message) => {
    if (worker.index === 0) {
      home.holdRefresh();
      home.error(worker, message);
    }
  };
  home.submit();
  await until(() => home.refreshHeld);
  assert.equal(home.get('import-button').disabled, false);
  home.submit();
  await until(() => home.workers[1]?.posts.length === 1);
  home.releaseRefresh();
  await settle();
  assert.equal(home.workers[0].terminated, true);
  assert.equal(home.workers[1].terminated, false);
  assert.equal(home.get('import-button').disabled, true);
  await home.cancel();
  await until(() => !home.get('import-button').disabled);
  await settle();
  assert.equal(
    home.workers[1].terminated,
    true,
    'the active import remains available to the Cancel handler',
  );
});

test('ZIP picker sends the unopened File to the worker and resets the picker', async (t) => {
  const home = await homeHarness(t),
    file = new File(['zip bytes'], 'sample-main.zip');
  file.arrayBuffer = () => {
    throw Error('No main-thread extraction');
  };
  const input = home.get('zip-input');
  input.files = [file];
  input.value = 'selected';
  input.onchange({ target: input });
  await until(() => home.workers[0]?.posts.length === 1);
  const args = home.workers[0].posts[0].args;
  assert.equal(args.archive, file);
  assert.equal(args.input, 'sample-main');
  assert.equal(args.files, null);
  assert.equal(input.value, '');
  assert.equal(input.disabled, true);
  await home.cancel();
  await settle();
  assert.equal(input.disabled, false);
});
test('ZIP drop rejects multiple or non-ZIP files and accepts one archive', async (t) => {
  const home = await homeHarness(t),
    zone = home.get('zip-drop');
  let prevented = 0;
  const drop = (files) =>
    zone.ondrop({
      preventDefault() {
        prevented++;
      },
      dataTransfer: { files },
    });
  drop([new File(['x'], 'a.txt')]);
  assert.equal(home.workers.length, 0);
  assert.match(home.get('import-error').textContent, /ZIP/i);
  drop([new File(['x'], 'a.zip'), new File(['x'], 'b.zip')]);
  assert.equal(home.workers.length, 0);
  assert.match(home.get('import-error').textContent, /one/i);
  drop([new File(['x'], 'sample.zip')]);
  await until(() => home.workers[0]?.posts.length === 1);
  assert.equal(home.workers[0].posts[0].args.archive.name, 'sample.zip');
  assert.equal(prevented, 3);
  await home.cancel();
  await settle();
});

test('a stuck storage-usage estimate never delays the worker import request', async (t) => {
  const home = await homeHarness(t);
  home.holdRefresh();
  home.submit();
  await until(() => home.refreshHeld);
  await until(() => home.workers[0]?.posts.length === 1);
  await home.cancel();
  await until(() => !home.get('import-button').disabled);
  home.releaseRefresh();
  await settle();
});

test('synchronous worker startup failure restores controls and displays the error', async (t) => {
  const home = await homeHarness(t);
  home.failWorkerStart();
  home.submit();
  await until(() => !home.get('import-button').disabled);
  assert.equal(home.get('progress-panel').hidden, true);
  assert.equal(home.get('import-error').hidden, false);
  assert.match(home.get('import-error').textContent, /Worker startup blocked/);
  assert.equal(home.intervals.size, 0);
});

test('import timer ticks without progress, resets on retry and stops on cancellation, failure and success', async (t) => {
  const home = await homeHarness(t);
  home.submit();
  await until(() => home.workers[0]?.posts.length === 1);
  assert.equal(home.intervals.size, 1);
  assert.equal(home.get('import-elapsed').textContent, '0s');
  home.advance(5000);
  assert.equal(home.get('import-elapsed').textContent, '5s');
  assert.equal(home.get('import-eta').textContent, 'Estimating…');
  for (const completed of [10, 20, 30]) {
    home.respond('progress', {
      stage: 'indexing',
      work: { phase: 'source', completed, total: 100 },
    });
    await settle();
    home.advance(1000);
  }
  assert.match(home.get('import-eta').textContent, /~\d+s · source/);
  await home.cancel();
  await settle();
  assert.equal(home.intervals.size, 0);
  home.advance(10000);
  home.submit();
  await until(() => home.workers[1]?.posts.length === 1);
  assert.equal(home.get('import-elapsed').textContent, '0s');
  assert.equal(home.get('import-eta').textContent, 'Estimating…');
  home.error(home.workers[1], home.workers[1].posts[0]);
  await settle();
  assert.equal(home.intervals.size, 0);
  home.submit();
  await until(() => home.workers[2]?.posts.length === 1);
  home.respond('result', { projectId: 'completed-map', stats: { files: 100 } });
  await settle();
  assert.equal(home.intervals.size, 0);
  assert.equal(home.get('progress-panel').hidden, true);
  assert.deepEqual(home.navigations, ['viewer.html?project=completed-map']);
});

test('worker chatter keeps one cache message, updates counts once a second and advances once to build', async (t) => {
  const home = await homeHarness(t);
  home.submit();
  await until(() => home.workers[0]?.posts.length === 1);
  await settle();
  const message = home.get('progress-message').textContent,
    title = home.get('progress-title').textContent;
  assert.match(message, /caching source/i);
  for (const stage of ['archive', 'unpacking', 'indexing', 'reading', 'retry', 'indexing']) {
    home.respond('progress', {
      stage,
      message: 'noisy worker ' + stage,
      work: { phase: 'source', completed: 30, total: 100 },
    });
    await settle();
    assert.equal(home.get('progress-message').textContent, message);
    assert.equal(home.get('progress-title').textContent, title);
  }
  assert.equal(home.get('progress-detail').textContent, '');
  home.advance(1000);
  assert.match(home.get('progress-detail').textContent, /30 \/ 100/);
  home.respond('progress', { stage: 'layout', work: { phase: 'layout', completed: 0, total: 0 } });
  await settle();
  const build = home.get('progress-message').textContent;
  assert.match(build, /building.*map/i);
  for (const stage of ['previews', 'indexing', 'saving']) {
    home.respond('progress', { stage, message: 'other' });
    await settle();
    assert.equal(home.get('progress-message').textContent, build);
  }
  await home.cancel();
  await settle();
  home.submit();
  await settle();
  assert.equal(home.get('progress-message').textContent, message);
  await home.cancel();
  await settle();
});
