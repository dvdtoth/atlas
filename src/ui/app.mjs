import { selectionPlanes2D, selectionPlanes3D } from '../render/source-selection.mjs';
import { createSourceMenu } from './source-menu.mjs';
import { flightTileDetail, tileTextureBytes, cachedTextTile } from '../render/text-detail.mjs';
import { openSnapshot, localRequest, projectId } from './viewer-client.mjs';
import { telemetry } from '../shared/telemetry.mjs';
import { GPUView } from '../render/gpu.mjs';
import { sourceFlightPose, keyboardFlightSpeed } from '../render/flight-navigation.mjs';
import {
  DEPTH,
  clamp,
  mix,
  ease,
  add,
  sub,
  mul,
  dot,
  length,
  norm,
  cross,
  basis,
  look,
  project,
  rayAt,
  surface,
  sourceAt,
  panelFor,
  travel,
  readNode,
} from '../render/core.mjs';
import { collect2D, collect3D, pick2D, pick3D } from '../render/visibility.mjs';

const $ = (id) => document.getElementById(id),
  canvas = $('gpu'),
  overlay = $('overlay'),
  ctx = overlay.getContext('2d'),
  stage = $('stage');
$('query').disabled = true;
for (const button of document.querySelectorAll('[data-mode]')) button.disabled = true;
const gpu = new GPUView(),
  textWorker = new Worker(
    new URL('../render/text-worker.mjs?project=' + encodeURIComponent(projectId), import.meta.url),
    { type: 'module' },
  ),
  decoder = new TextDecoder();
let scene,
  manifest,
  paths,
  idIndex,
  ready = false,
  mode = '2d',
  mapCamera,
  flightCamera,
  animation = null,
  history = [],
  selected = -1,
  selectedAddress = null,
  selectedRange = null,
  visible = { folders: [], files: [], folds: [] },
  w = 1,
  h = 1,
  dpr = 1,
  dirty = true,
  lastCollect = 0,
  lastStats = 0,
  frameCount = 0,
  frameTime = 0,
  lastFrame = performance.now(),
  pointer = { x: 0, y: 0, inside: false },
  drag = null,
  keys = new Set(),
  velocity = [0, 0, 0],
  speed = 100,
  speedFactor = 1,
  searchMode = 'all',
  searchResults = [],
  searchVersion = 0,
  searchAbort,
  searchTimer,
  sourcePage = null,
  sourceVersion = 0,
  navigationEpoch = 0;
const fileWorker = new Worker(new URL('../index/file-search-worker.mjs', import.meta.url), {
  type: 'module',
});
let fileReadyResolve,
  fileReadyReject,
  filePending,
  fileToken = 0;
const fileReady = new Promise((resolve, reject) => {
  fileReadyResolve = resolve;
  fileReadyReject = reject;
});
fileWorker.onmessage = ({ data }) => {
  if (data.type === 'error') {
    if (data.token === undefined) fileReadyReject(Error(data.error));
    else if (filePending?.token === data.token) {
      filePending.reject(Error(data.error));
      filePending = null;
    }
    return;
  }
  if (data.type === 'ready') fileReadyResolve(data);
  if (data.type === 'results' && filePending?.token === data.token) {
    filePending.resolve({ ...data, status: 'complete' });
    filePending = null;
  }
};
fileWorker.onerror = (e) => fileReadyReject(Error(e.message));
async function filenameSearch(query) {
  await fileReady;
  if (filePending) filePending.resolve({ results: [], status: 'partial' });
  return new Promise((resolve, reject) => {
    const token = ++fileToken;
    filePending = { token, resolve, reject };
    fileWorker.postMessage({ type: 'search', token, query, limit: 40 });
  });
}
const names = new Map(),
  textures = new Map(),
  pending = new Map(),
  revisions = new Map(),
  segments = new Map();
let textureBytes = 0,
  tileDraws = [],
  wanted = new Set(),
  wantedBytes = 0,
  settleTimer,
  budgetSamplePending = false,
  lastBudgetSample = -Infinity,
  budgetGeneration = 0;
const sourceMenu = createSourceMenu({
  manifest: () => manifest,
  readDocument: (args) => json('/api/document?' + new URLSearchParams(args)),
});
function fail(error) {
  if (!$('error').hidden) return;
  ready = false;
  console.error(error);
  $('error').hidden = false;
  $('error').textContent = String(error?.message || error);
}
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));
async function json(url, signal) {
  return localRequest(url, signal);
}
function node(i, display = mode === '2d') {
  return readNode(scene.view, i, display);
}
function path(n) {
  let value = names.get(n.index);
  if (value !== undefined) return value;
  value =
    decoder.decode(paths.subarray(n.pathOffset, n.pathOffset + n.pathLength)) ||
    manifest.sourceRepo ||
    'repository';
  if (names.size > 3000) names.delete(names.keys().next().value);
  names.set(n.index, value);
  return value;
}
function filename(n) {
  return path(n).split('/').pop();
}
function status(message) {
  $('load-message').textContent = message;
}
function coordinates(x, y) {
  return {
    x: mapCamera.x + (x - w / 2) / mapCamera.scale,
    y: mapCamera.y + (y - h / 2) / mapCamera.scale,
  };
}
function screen(n) {
  return {
    x: (n.x - mapCamera.x) * mapCamera.scale + w / 2,
    y: (n.y - mapCamera.y) * mapCamera.scale + h / 2,
    w: n.w * mapCamera.scale,
    h: n.h * mapCamera.scale,
  };
}
function copyCamera() {
  return mode === '2d' ? { ...mapCamera } : { ...flightCamera, eye: [...flightCamera.eye] };
}
function remember() {
  if (!ready) return;
  history.push({
    mode,
    cam: copyCamera(),
    selected,
    address: selectedAddress,
    range: selectedRange,
  });
  if (history.length > 40) history.shift();
  $('back').disabled = false;
}
function mark() {
  dirty = true;
  lastCollect = 0;
}
function resize() {
  const r = stage.getBoundingClientRect();
  w = Math.max(1, r.width);
  h = Math.max(1, r.height);
  dpr = Math.min(2, devicePixelRatio || 1);
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (ready) gpu.resize(overlay.width, overlay.height);
  mark();
}
new ResizeObserver(resize).observe(stage);
function rootCamera() {
  const [x, y, rw, rh] = manifest.root;
  return { x: x + rw / 2, y: y + rh / 2, scale: Math.min((w - 32) / rw, (h - 70) / rh) };
}
function animateMap(target, duration = 2000) {
  animation = {
    mode: '2d',
    from: { ...mapCamera },
    to: target,
    start: performance.now(),
    duration,
  };
  mark();
}
function animateFlight(target, duration = 1700) {
  let from = { ...flightCamera, eye: [...flightCamera.eye] };
  let yaw = target.yaw;
  while (yaw - from.yaw > Math.PI) yaw -= 2 * Math.PI;
  while (yaw - from.yaw < -Math.PI) yaw += 2 * Math.PI;
  animation = { mode: '3d', from, to: { ...target, yaw }, start: performance.now(), duration };
  mark();
}
function fadeSnapshot() {
  const c = $('transition');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  c.style.transition = 'none';
  c.style.opacity = '1';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      c.style.transition = 'opacity .65s ease';
      c.style.opacity = '0';
    }),
  );
}
function setMode(next) {
  budgetGeneration++;
  sourceMenu.hide();
  mode = next;
  telemetry.track('view_changed', { mode });
  $('map').classList.toggle('active', mode === '2d');
  $('flight').classList.toggle('active', mode === '3d');
  $('reticle').style.display = mode === '3d' ? 'block' : 'none';
  $('read').hidden = mode !== '3d';
  $('lock').hidden = mode !== '3d';
  $('controls').textContent =
    mode === '2d'
      ? 'DRAG to pan · SCROLL to zoom · DOUBLE CLICK to frame a file'
      : 'DRAG to look · WASD to fly · SPACE / C vertical · SHIFT boost · SCROLL speed';
  $('tip').style.display = 'none';
  keys.clear();
  velocity = [0, 0, 0];
  visible = { folders: [], files: [], folds: [] };
  tileDraws = [];
  mark();
}
function overview(save = true) {
  if (!ready) return;
  navigationEpoch++;
  if (save) remember();
  if (mode === '2d') animateMap(rootCamera(), 1200);
  else {
    const [x, y, rw, rh] = manifest.root,
      target = [x + rw * 0.5, scene.tops[0] * 0.25, (y + rh * 0.5) * DEPTH],
      eye = [target[0], Math.max(scene.tops[0] * 1.3, rw * 0.55), target[2] + rw * 0.33];
    animateFlight({ eye, ...look(eye, target) }, 1800);
    speed = rw * 0.13;
  }
}
function focusFlight(index, line = 0, column = 0, reading = true) {
  const pose = sourceFlightPose(node(index, false), line, column, scene.elevations[index], reading),
    { target, fold } = pose;
  speed = pose.speed;
  let view = { eye: pose.eye, yaw: pose.yaw, pitch: pose.pitch };
  const candidates = collect3D(scene, view, w, h).folds.filter(
      (g) => !(g.node === index && g.start === fold.start),
    ),
    ray = norm(sub(view.eye, target));
  const obstruction = pick3D(candidates, add(target, mul(ray, fold.lineHeight * 0.03)), ray);
  if (obstruction && obstruction.distance < length(sub(view.eye, target))) {
    view.eye = add(target, mul(ray, Math.max(fold.lineHeight * 2, obstruction.distance * 0.65)));
    view = { ...view, ...look(view.eye, target) };
  }
  return view;
}

async function changeMode(next) {
  const epoch = ++navigationEpoch;
  if (!ready || next === mode) return;
  remember();
  animation = null;
  fadeSnapshot();
  if (next === '3d') {
    const hit = pick2D(scene, mapCamera.x, mapCamera.y);
    let target;
    if (hit) {
      let address = sourceAt(hit, mapCamera.x, mapCamera.y);
      let raw = selectedAddress?.id === hit.id ? selectedAddress.line : 0;
      if (address) {
        try {
          const p = await json(
            `/api/document?id=${hit.id}&start=${address.line}&count=1&display=1`,
          );
          raw = p.lineMap[0] ?? raw;
        } catch {}
      }
      target = focusFlight(hit.index, raw, 0, mapCamera.scale * surface(hit).lineHeight > 2);
    } else {
      const span = h / mapCamera.scale,
        targetPoint = [mapCamera.x, scene.tops[0] * 0.2, mapCamera.y * DEPTH],
        eye = [mapCamera.x, span * 0.7 + targetPoint[1], mapCamera.y * DEPTH + span * 0.28];
      target = { eye, ...look(eye, targetPoint) };
      speed = span * 0.2;
    }
    if (epoch !== navigationEpoch) return;
    flightCamera = { ...target, eye: add(target.eye, [0, speed * 0.6, speed * 0.35]) };
    flightCamera = {
      ...flightCamera,
      ...look(
        flightCamera.eye,
        add(target.eye, mul(basis(target.yaw, target.pitch).forward, speed)),
      ),
    };
    setMode('3d');
    animateFlight(target, 900);
  } else {
    if (document.pointerLockElement) document.exitPointerLock();
    const hit = pick3D(visible.folds, flightCamera.eye, rayAt(w / 2, h / 2, flightCamera, w, h));
    let target;
    if (hit) {
      const n = node(hit.node, true);
      const address = await json(
        `/api/address?id=${n.id}&line=${hit.line}&column=${hit.column}`,
      ).catch(() => ({ displayLine: hit.line, displayColumn: 0 }));
      target = mapTarget(n, address.displayLine, address.displayColumn, 10);
    } else {
      const b = basis(flightCamera.yaw, flightCamera.pitch),
        distance =
          b.forward[1] < -0.02
            ? Math.max(0, (flightCamera.eye[1] - scene.bases[0]) / -b.forward[1])
            : speed * 3,
        point = add(flightCamera.eye, mul(b.forward, distance));
      target = { x: point[0], y: point[2] / DEPTH, scale: h / Math.max(speed * 5, 1) };
    }
    if (epoch !== navigationEpoch) return;
    mapCamera = { ...target, scale: target.scale * 0.72 };
    setMode('2d');
    animateMap(target, 850);
  }
}
function mapTarget(n, line = 0, column = 0, pixels = 12) {
  const s = surface(n),
    b = s.panel(panelFor(s, line)),
    scale = Math.min(
      pixels / s.lineHeight,
      (w * 0.75) / (Math.min(n.columns, 110) * s.lineHeight * 0.45),
    );
  return {
    x: b.x + Math.min(Math.max(column + 35, 35), n.columns * 0.5) * s.lineHeight * 0.45,
    y: b.y + (line - b.start + 9) * s.lineHeight,
    scale: Math.max(scale, 1e-6),
  };
}
async function navigate(result) {
  if (!ready) return;
  const index = idIndex[result.id] ?? -1;
  if (index < 0) return;
  const epoch = ++navigationEpoch;
  remember();
  selected = index;
  selectedRange = null;
  selectedAddress = {
    id: result.id,
    line: result.line || 0,
    column: result.column || 0,
    endLine: result.endLine,
    endColumn: result.endColumn,
    kind: result.kind,
  };
  highlight();
  inspect(result.id, result.line || 0);
  mark();
  const args = new URLSearchParams({
    id: result.id,
    line: result.line || 0,
    column: result.column || 0,
  });
  if (result.endLine !== undefined && result.endColumn !== undefined) {
    args.set('endLine', result.endLine);
    args.set('endColumn', result.endColumn);
  }
  const target = await json(
    `/api/${result.kind === 'file' ? 'address' : 'selection'}?${args}`,
  ).catch(() => null);
  if (epoch !== navigationEpoch) return;
  selectedRange = target?.display ? target : null;
  const a = target?.address ||
    target || { displayLine: result.line || 0, displayColumn: result.column || 0 };
  if (mode === '2d')
    animateMap(
      mapTarget(
        node(selected, true),
        a.displayLine,
        a.displayColumn,
        result.kind === 'file' ? 7 : 14,
      ),
    );
  else animateFlight(focusFlight(selected, result.line || 0, result.column || 0), 2000);
  renderResults();
  mark();
  telemetry.track('result_selected', { mode });
  location.replace(`#file=${result.id}&line=${(result.line || 0) + 1}`);
}
function selectionPlanes() {
  if (!selectedRange || selectedRange.id !== selectedAddress?.id || selected < 0) return [];
  return mode === '2d'
    ? selectionPlanes2D(node(selected, true), selectedRange.display)
    : selectionPlanes3D(node(selected, false), selectedRange.source, visible.folds);
}
function highlight() {
  gpu.highlight(
    searchResults.map((r) => idIndex[r.id]).filter((x) => x >= 0),
    selected,
  );
  dirty = true;
}
async function inspect(id, line = 0, start = Math.max(0, line - 12)) {
  const version = ++sourceVersion;
  $('inspector').hidden = false;
  $('source-path').textContent = path(node(idIndex[id]));
  $('source-meta').textContent = 'Reading cached source…';
  try {
    const page = await json(`/api/document?id=${id}&start=${start}&count=80`);
    if (version !== sourceVersion) return;
    sourcePage = { ...page, line };
    revisions.set(id, page.revision);
    $('source-meta').textContent =
      `${page.sourceTotalLines.toLocaleString()} lines · snapshot ${page.revision.slice(0, 10)}`;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < page.sourceLines.length; i++) {
      const row = document.createElement('span');
      row.className = 'line' + (page.start + i === line ? ' current' : '');
      row.dataset.sourceLine = String(page.start + i);
      const num = document.createElement('span');
      num.className = 'number';
      num.textContent = page.start + i + 1;
      row.append(num, document.createTextNode(page.sourceLines[i]));
      frag.append(row);
    }
    $('source-code').replaceChildren(frag);
    $('source-code').scrollTop = 0;
    if (!segments.has(id)) {
      segments.set(id, []);
      json(`/api/segments?id=${id}`)
        .then((r) => {
          segments.set(id, r.segments || []);
          if (segments.size > 10) segments.delete(segments.keys().next().value);
        })
        .catch(() => {});
    }
  } catch (e) {
    if (version === sourceVersion) $('source-meta').textContent = e.message;
  }
}
function renderResults() {
  if (!searchResults.length) {
    $('results').replaceChildren();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const result of searchResults) {
    const b = document.createElement('button');
    b.className =
      'result' +
      (idIndex[result.id] === selected &&
      result.line === selectedAddress?.line &&
      result.column === selectedAddress?.column
        ? ' selected'
        : '');
    const k = document.createElement('span');
    k.className = 'kind';
    k.textContent = result.symbolKind || result.kind;
    const title = document.createElement('strong');
    title.textContent = result.name || result.path.split('/').pop();
    title.prepend(k);
    const p = document.createElement('span');
    p.className = 'path';
    p.textContent = `${result.path}${result.kind === 'file' ? '' : `:${result.line + 1}`}`;
    b.append(title, p);
    if (result.preview) {
      const code = document.createElement('span');
      code.className = 'snippet';
      code.textContent = result.preview;
      b.append(code);
    }
    b.onclick = () => navigate(result);
    fragment.append(b);
  }
  $('results').replaceChildren(fragment);
}
async function search(exhaustive = false) {
  clearTimeout(searchTimer);
  const q = $('query').value.trim(),
    version = ++searchVersion;
  searchAbort?.abort();
  if (!q) {
    searchResults = [];
    renderResults();
    if (ready) highlight();
    $('search-status').textContent = 'Search the source stored on this device.';
    return;
  }
  const controller = (searchAbort = new AbortController()),
    start = performance.now();
  $('search-status').textContent = exhaustive ? 'Searching the index…' : 'Finding suggestions…';
  try {
    let report;
    if (searchMode === 'files') report = await filenameSearch(q);
    else {
      const request = json(
        `/api/${exhaustive || searchMode === 'text' ? 'search' : 'suggest'}?q=${encodeURIComponent(q)}&mode=${searchMode}&limit=40`,
        controller.signal,
      );
      if (searchMode === 'all') {
        const [symbols, files] = await Promise.all([request, filenameSearch(q)]);
        const hits = new Map();
        for (const hit of [...symbols.results, ...files.results])
          hits.set(`${hit.id}:${hit.kind}:${hit.line}:${hit.column}`, hit);
        report = {
          ...symbols,
          results: [...hits.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 40),
        };
      } else report = await request;
    }
    if (version !== searchVersion) return;
    searchResults = report.results;
    telemetry.track('search_used', { mode: searchMode, results: report.results.length });
    renderResults();
    if (ready) highlight();
    $('search-status').textContent =
      `${report.results.length} ${report.status === 'complete' ? 'matches' : 'candidates'} · ${Math.round(performance.now() - start)} ms${report.status === 'complete' ? '' : searchMode === 'text' ? ' · bounded source scan' : ' · partial index/results'}`;
  } catch (e) {
    if (e.name !== 'AbortError' && version === searchVersion)
      $('search-status').textContent = e.message;
  }
}
$('query').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(), 75);
};
$('query').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    search(true);
  }
  if (e.key === 'ArrowDown') {
    $('results').querySelector('button')?.focus();
    e.preventDefault();
  }
};
for (const b of document.querySelectorAll('[data-mode]'))
  b.onclick = () => {
    searchMode = b.dataset.mode;
    for (const t of document.querySelectorAll('[data-mode]')) {
      t.classList.toggle('active', t === b);
      t.setAttribute('aria-selected', String(t === b));
    }
    search();
  };
$('sidebar-toggle').onclick = () => {
  const closed = document.querySelector('aside').classList.toggle('collapsed');
  $('sidebar-toggle').setAttribute('aria-pressed', String(!closed));
};
$('map').onclick = () => changeMode('2d');
$('flight').onclick = () => changeMode('3d');
$('fit').onclick = () => overview();
$('back').disabled = true;
$('back').onclick = () => {
  navigationEpoch++;
  sourceVersion++;
  const item = history.pop();
  if (!item) return;
  fadeSnapshot();
  animation = null;
  setMode(item.mode);
  if (mode === '2d') mapCamera = item.cam;
  else flightCamera = item.cam;
  selected = item.selected;
  selectedAddress = item.address;
  selectedRange = item.range || null;
  highlight();
  $('back').disabled = !history.length;
  mark();
};
$('read').onclick = () => readHere();
$('lock').onclick = () => canvas.requestPointerLock();
$('close-inspector').onclick = () => {
  $('inspector').hidden = true;
};
$('previous-lines').onclick = () => {
  if (sourcePage) inspect(sourcePage.id, sourcePage.line, Math.max(0, sourcePage.start - 70));
};
$('next-lines').onclick = () => {
  if (sourcePage)
    inspect(sourcePage.id, sourcePage.line, Math.min(sourcePage.totalLines, sourcePage.start + 70));
};
$('locate').onclick = () => {
  if (sourcePage)
    navigate(
      selectedAddress?.id === sourcePage.id && selectedAddress.line === sourcePage.line
        ? selectedAddress
        : { id: sourcePage.id, line: sourcePage.line, column: 0 },
    );
};
function readHere() {
  const hit = pick3D(visible.folds, flightCamera.eye, rayAt(w / 2, h / 2, flightCamera, w, h));
  if (hit) navigate({ id: hit.id, line: hit.line, column: hit.column });
}
canvas.addEventListener('pointerdown', (e) => {
  if (!ready || e.button !== 0) return;
  navigationEpoch++;
  canvas.focus();
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, distance: 0 };
  animation = null;
});
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true };
  if (drag || document.pointerLockElement === canvas) {
    const dx = document.pointerLockElement === canvas ? e.movementX : e.clientX - drag.x,
      dy = document.pointerLockElement === canvas ? e.movementY : e.clientY - drag.y;
    if (drag) {
      drag.distance += Math.hypot(dx, dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
    }
    if (mode === '2d') {
      mapCamera.x -= dx / mapCamera.scale;
      mapCamera.y -= dy / mapCamera.scale;
    } else {
      flightCamera.yaw += dx * 0.003;
      flightCamera.pitch = clamp(flightCamera.pitch - dy * 0.003, -1.54, 1.54);
    }
    animation = null;
    dirty = true;
  } else dirty = true;
});
canvas.addEventListener('pointerup', async (e) => {
  if (drag && drag.distance < 4 && ready && document.pointerLockElement !== canvas) {
    if (mode === '2d') {
      const p = coordinates(pointer.x, pointer.y),
        n = pick2D(scene, p.x, p.y);
      if (n) {
        const epoch = ++navigationEpoch;
        const a = sourceAt(n, p.x, p.y);
        selected = n.index;
        selectedRange = null;
        selectedAddress = { id: n.id, line: 0, column: 0 };
        highlight();
        try {
          const page = await json(
            `/api/document?id=${n.id}&start=${a?.line || 0}&count=1&display=1`,
          );
          if (epoch !== navigationEpoch) return;
          const line = page.lineMap[0] || 0;
          selectedAddress = { id: n.id, line, column: a?.column || 0 };
          inspect(n.id, line);
        } catch {
          if (epoch === navigationEpoch) inspect(n.id, 0);
        }
      }
    } else {
      const hit = pick3D(
        visible.folds,
        flightCamera.eye,
        rayAt(pointer.x, pointer.y, flightCamera, w, h),
      );
      if (hit) {
        selected = hit.node;
        selectedRange = null;
        selectedAddress = { id: hit.id, line: hit.line, column: hit.column };
        highlight();
        inspect(hit.id, hit.line);
      }
    }
  }
  drag = null;
  mark();
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!ready) return;
  const r = canvas.getBoundingClientRect(),
    locked = document.pointerLockElement === canvas,
    x = locked ? w / 2 : e.clientX - r.left,
    y = locked ? h / 2 : e.clientY - r.top;
  let address;
  if (mode === '2d') {
    const point = coordinates(x, y),
      n = pick2D(scene, point.x, point.y);
    if (n) {
      const hit = sourceAt(n, point.x, point.y);
      address = { id: n.id, path: path(n), line: hit?.line ?? null, display: true };
    }
  } else {
    const hit = pick3D(visible.folds, flightCamera.eye, rayAt(x, y, flightCamera, w, h));
    if (hit)
      address = { id: hit.id, path: path(node(hit.node, false)), line: hit.line, display: false };
  }
  if (!address) {
    sourceMenu.hide();
    return;
  }
  $('tip').style.display = 'none';
  if (locked) document.exitPointerLock();
  navigationEpoch++;
  animation = null;
  keys.clear();
  velocity = [0, 0, 0];
  drag = null;
  sourceMenu.show(locked ? r.left + w / 2 : e.clientX, locked ? r.top + h / 2 : e.clientY, address);
});
$('source-code').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.line');
  if (!row || !sourcePage) return;
  e.preventDefault();
  sourceMenu.show(e.clientX, e.clientY, {
    id: sourcePage.id,
    path: sourcePage.path || path(node(idIndex[sourcePage.id])),
    line: Number(row.dataset.sourceLine),
    display: false,
  });
});
$('source-path').addEventListener('contextmenu', (e) => {
  if (!sourcePage) return;
  e.preventDefault();
  sourceMenu.show(e.clientX, e.clientY, {
    id: sourcePage.id,
    path: path(node(idIndex[sourcePage.id])),
    line: null,
    display: false,
  });
});
canvas.addEventListener('pointerleave', () => {
  pointer.inside = false;
  $('tip').style.display = 'none';
});
canvas.addEventListener('dblclick', () => {
  if (!ready) return;
  if (mode === '3d') {
    readHere();
    return;
  }
  const p = coordinates(pointer.x, pointer.y),
    n = pick2D(scene, p.x, p.y);
  if (n) {
    remember();
    animateMap(
      { x: n.x + n.w / 2, y: n.y + n.h / 2, scale: Math.min((w - 80) / n.w, (h - 100) / n.h) },
      900,
    );
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!ready) return;
    navigationEpoch++;
    animation = null;
    if (mode === '2d') {
      const r = canvas.getBoundingClientRect(),
        px = e.clientX - r.left,
        py = e.clientY - r.top,
        p = coordinates(px, py),
        factor = Math.exp(clamp(-e.deltaY * (e.ctrlKey ? 0.009 : 0.0025), -0.65, 0.65));
      mapCamera.scale = clamp(mapCamera.scale * factor, rootCamera().scale * 0.2, 1e10);
      mapCamera.x = p.x - (px - w / 2) / mapCamera.scale;
      mapCamera.y = p.y - (py - h / 2) / mapCamera.scale;
    } else {
      speedFactor = clamp(speedFactor * Math.exp(-e.deltaY * 0.0025), 0.05, 100);
    }
    $('tip').style.display = 'none';
    dirty = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(mark, 120);
  },
  { passive: false },
);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.querySelector('aside').classList.remove('collapsed');
    $('sidebar-toggle').setAttribute('aria-pressed', 'true');
    $('query').focus();
    return;
  }
  if (e.target instanceof HTMLInputElement || sourceMenu.visible) return;
  if (e.key === 'Escape') {
    keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    animation = null;
    return;
  }
  if (!ready) return;
  const k = e.key.toLowerCase();
  if (k === 'f' && mode === '3d') readHere();
  if (k === 'r' && mode === '3d') changeMode('2d');
  if (k === 'home') {
    e.preventDefault();
    overview();
  }
  if (mode === '3d' && ['w', 'a', 's', 'd', 'q', 'e', 'c', ' ', 'shift', 'x'].includes(k)) {
    e.preventDefault();
    keys.add(k);
    animation = null;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => {
  keys.clear();
  drag = null;
  velocity = [0, 0, 0];
});

function background(n) {
  const c = [n.color & 255, (n.color >>> 8) & 255, (n.color >>> 16) & 255],
    base = [0.012, 0.019, 0.024];
  return (
    '#' +
    c
      .map((v, i) =>
        Math.round((v * 0.105 + base[i] * 255) * (mode === '3d' ? 0.8 : 1))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function trimTextures() {
  const limit = gpu.textBudget.current.cacheBytes,
    keep = new Set(tileDraws.map((t) => t.tile));
  for (const [key, value] of textures) {
    if (textureBytes <= limit) break;
    if (keep.has(value)) continue;
    textures.delete(key);
    textureBytes -= value.bytes;
    value.texture.destroy();
  }
}
function requestTile(n, start, column, scale = 1) {
  const policy = gpu.textBudget.current,
    base = `${n.id}:${mode}:${start}:${column}:`,
    key = base + scale,
    limit = mode === '3d' ? policy.workingBytes : Math.min(144 * 1048576, policy.workingBytes);
  const cached = cachedTextTile(textures, base, scale, revisions.get(n.id));
  if (!wanted.has(key)) {
    const requestedBytes =
      mode === '3d' ? tileTextureBytes(scale) : 128 * 32 * 9 * 20 * 4 * scale * scale;
    // Refinement may temporarily draw a larger cached raster; budget its actual size.
    const bytes = Math.max(requestedBytes, cached?.tile.bytes || 0);
    if (wantedBytes + bytes > limit || wanted.size >= policy.maxDraws) return null;
    wantedBytes += bytes;
    wanted.add(key);
  }
  if (cached) {
    textures.delete(cached.key);
    textures.set(cached.key, cached.tile);
  }
  if (
    cached?.key !== key &&
    !pending.has(key) &&
    pending.size < (mode === '3d' ? policy.maxPending : 32)
  ) {
    const req = {
      type: 'tile',
      key,
      id: n.id,
      display: mode === '2d',
      start,
      column,
      scale,
      background: background(n),
      revision: revisions.get(n.id),
    };
    pending.set(key, performance.now());
    textWorker.postMessage(req);
  }
  return cached?.tile || null;
}
textWorker.onmessage = ({ data }) => {
  pending.delete(data.key);
  if (data.type === 'tile-error') {
    console.warn(data.error);
    return;
  }
  if (data.type !== 'tile') return;
  if (!wanted.has(data.key)) {
    data.bitmap.close();
    return;
  }
  try {
    const tile = gpu.uploadTile(data.bitmap, { mipmapped: !data.display });
    data.bitmap.close();
    const old = textures.get(data.key);
    if (old) {
      textureBytes -= old.bytes;
      old.texture.destroy();
    }
    textures.set(data.key, { ...tile, ...data, bitmap: undefined });
    textureBytes += tile.bytes;
    revisions.set(data.id, data.revision);
    trimTextures();
    dirty = true;
    lastCollect = 0;
  } catch (e) {
    fail(e);
  }
};
function planeCrop(origin, across, down) {
  const normal = cross(across, down),
    us = [],
    vs = [];
  for (const [x, y] of [
    [-20, -20],
    [w + 20, -20],
    [-20, h + 20],
    [w + 20, h + 20],
    [w / 2, h / 2],
  ]) {
    const ray = rayAt(x, y, flightCamera, w, h),
      den = dot(normal, ray);
    if (Math.abs(den) < 1e-12) continue;
    const dist = dot(normal, sub(origin, flightCamera.eye)) / den;
    if (dist < 0) continue;
    const p = sub(add(flightCamera.eye, mul(ray, dist)), origin);
    us.push(dot(p, across) / dot(across, across));
    vs.push(dot(p, down) / dot(down, down));
  }
  return us.length
    ? {
        u0: clamp(Math.min(...us), 0, 1),
        u1: clamp(Math.max(...us), 0, 1),
        v0: clamp(Math.min(...vs), 0, 1),
        v1: clamp(Math.max(...vs), 0, 1),
      }
    : { u0: 0, u1: 1, v0: 0, v1: 1 };
}
function collectTiles() {
  wanted = new Set();
  wantedBytes = 0;
  const policy = gpu.textBudget.current,
    draws = [];
  if (mode === '2d') {
    const low = coordinates(-20, -20),
      high = coordinates(w + 20, h + 20);
    const files = [...visible.files];
    if (selected >= 0 && !files.some((n) => n.index === selected)) {
      const n = node(selected, true),
        r = screen(n);
      if (r.x + r.w > 0 && r.x < w && r.y + r.h > 0 && r.y < h) files.unshift(n);
    }
    for (const n of files) {
      const s = surface(n),
        pixels = s.lineHeight * mapCamera.scale;
      if (pixels < 1.6) continue;
      for (let p = 0; p < s.panels; p++) {
        const b = s.panel(p);
        if (b.x > high.x || b.x + b.w < low.x || b.y > high.y || b.y + b.h < low.y) continue;
        const start = clamp(
            b.start + Math.floor((low.y - b.y) / s.lineHeight),
            b.start,
            b.start + b.count - 1,
          ),
          end = clamp(
            b.start + Math.ceil((high.y - b.y) / s.lineHeight),
            b.start,
            b.start + b.count,
          ),
          col0 = clamp(Math.floor((low.x - b.x) / (0.45 * s.lineHeight)), 0, n.columns),
          col1 = clamp(Math.ceil((high.x - b.x) / (0.45 * s.lineHeight)), 0, n.columns);
        for (let row = Math.floor(start / 32) * 32; row < end && draws.length < 150; row += 32)
          for (
            let col = Math.floor(col0 / 128) * 128;
            col < col1 && draws.length < 150;
            col += 128
          ) {
            const tile = requestTile(n, row, col, pixels * dpr > 28 ? 2 : 1);
            if (!tile) continue;
            const a = Math.max(row, b.start),
              z = Math.min(row + tile.rows, b.start + b.count),
              cw = Math.min(128, n.columns - col);
            if (z <= a || cw <= 0) continue;
            draws.push({
              tile,
              origin: [b.x + col * 0.45 * s.lineHeight, b.y + (a - b.start) * s.lineHeight, 0],
              across: [cw * 0.45 * s.lineHeight, 0, 0],
              down: [0, (z - a) * s.lineHeight, 0],
              uv: [0, (a - row) / 32, cw / 128, (z - a) / 32],
              opacity: clamp((pixels - 1.6) / 2, 0, 1),
            });
          }
      }
    }
  } else {
    let examined = 0;
    for (const f of visible.folds) {
      if (draws.length >= policy.maxDraws || examined >= policy.maxExamined) break;
      const n = node(f.node, false),
        crop = planeCrop(f.origin, f.across, f.down),
        start = f.start + Math.floor(crop.v0 * f.count),
        end = Math.min(f.start + f.count, f.start + Math.ceil(crop.v1 * f.count) + 1),
        cols = Math.max(1, n.columns),
        c0 = Math.floor(crop.u0 * cols),
        c1 = Math.ceil(crop.u1 * cols);
      for (
        let row = Math.floor(start / 32) * 32;
        row < end && draws.length < policy.maxDraws && examined < policy.maxExamined;
        row += 32
      )
        for (
          let col = Math.floor(c0 / 128) * 128;
          col < c1 && draws.length < policy.maxDraws && examined < policy.maxExamined;
          col += 128
        ) {
          examined++;
          const cw = Math.min(128, cols - col),
            a = Math.max(row, f.start),
            z = Math.min(row + 32, f.start + f.count);
          if (z <= a || cw <= 0) continue;
          const origin = add(
              add(f.origin, mul(f.across, col / cols)),
              mul(f.down, (a - f.start) / f.count),
            ),
            across = mul(f.across, cw / cols),
            down = mul(f.down, (z - a) / f.count);
          const detail = flightTileDetail(
            origin,
            across,
            down,
            z - a,
            cw,
            flightCamera,
            w,
            h,
            dpr,
            policy.minPixels,
          );
          if (!detail) continue;
          const tile = requestTile(n, row, col, detail.scale);
          if (!tile) continue;
          const final = Math.min(z, row + tile.rows);
          if (final <= a) continue;
          draws.push({
            tile,
            origin,
            across,
            down: mul(down, (final - a) / (z - a)),
            uv: [0, (a - row) / 32, cw / 128, (final - a) / 32],
            opacity: detail.opacity,
          });
        }
    }
  }
  const cancel = [];
  for (const [key, since] of pending)
    if (!wanted.has(key) && performance.now() - since > 160) {
      pending.delete(key);
      cancel.push(key);
    }
  if (cancel.length) textWorker.postMessage({ type: 'cancel', keys: cancel });
  tileDraws = draws;
  trimTextures();
}
function labels() {
  ctx.clearRect(0, 0, w, h);
  const placed = [],
    fit = (x, y, ww, hh) => {
      if (x < 2 || y < 2 || x + ww > w - 2 || y + hh > h - 65) return false;
      if (
        placed.some(
          (r) => x < r.x + r.w + 4 && x + ww + 4 > r.x && y < r.y + r.h + 3 && y + hh + 3 > r.y,
        )
      )
        return false;
      placed.push({ x, y, w: ww, h: hh });
      return true;
    };
  ctx.font = '10px Menlo, monospace';
  ctx.textBaseline = 'top';
  let count = 0;
  const reading3D =
    mode === '3d' &&
    visible.folds.some((f) => f.projectedLineHeight > 7 && f.screenArea > w * h * 0.45);
  for (const n of visible.folders) {
    if (reading3D) break;
    let x, y, ww, hh;
    if (mode === '2d') {
      const r = screen(n);
      x = r.x;
      y = r.y;
      ww = r.w;
      hh = r.h;
      if (ww > 20 && hh > 20) {
        ctx.lineWidth = Math.min(0.7, 0.28 + Math.sqrt(ww * hh) / 1500);
        ctx.strokeStyle = '#85989e70';
        ctx.strokeRect(x + 0.3, y + 0.3, ww - 0.6, hh - 0.6);
      }
    } else {
      if (n.viewDepth > speed * 25 || n.depth < 3) continue;
      const p = project([n.x, scene.bases[n.index], n.y * DEPTH], flightCamera, w, h);
      if (!p) continue;
      x = p.x;
      y = p.y;
      ww = 100;
      hh = 20;
    }
    if (count >= 55 || ww < 42 || hh < 18) continue;
    let label = filename(n) + (mode === '3d' ? '/' : '');
    let tw = ctx.measureText(label).width;
    if (tw > ww - 9 && mode === '2d') continue;
    x = Math.max(3, x + 3);
    y = Math.max(3, y + 3);
    if (!fit(x, y, tw + 8, 16)) continue;
    ctx.fillStyle = '#3a454be8';
    ctx.fillRect(x, y, tw + 8, 16);
    ctx.fillStyle = '#eef3f3';
    ctx.fillText(label, x + 4, y + 3);
    count++;
  }
  for (const n of visible.files) {
    if (count > 85) break;
    let x, y, ww, hh;
    if (mode === '2d') {
      const r = screen(n);
      ({ x, y, w: ww, h: hh } = r);
    } else continue;
    if (ww < 95 || hh < 25) continue;
    let label = filename(n),
      tw = ctx.measureText(label).width;
    if (tw > ww - 8) continue;
    x = Math.max(3, x + 4);
    y = Math.max(3, y + 4);
    if (!fit(x, y, tw, 13)) continue;
    ctx.fillStyle = '#e0e9eb';
    ctx.fillText(label, x, y);
    count++;
  }
  if (mode === '2d' && selectedAddress && selected >= 0) {
    const n = node(selected, true);
    const r = screen(n);
    ctx.strokeStyle = '#f9cf6a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
  }
}
function tooltip() {
  if (sourceMenu.visible || !pointer.inside || drag || document.pointerLockElement === canvas) {
    $('tip').style.display = 'none';
    return;
  }
  let text = '',
    hit;
  if (mode === '2d') {
    const p = coordinates(pointer.x, pointer.y),
      n = pick2D(scene, p.x, p.y);
    if (n) {
      hit = sourceAt(n, p.x, p.y);
      let line = hit?.line;
      const key = line === undefined ? null : `${n.id}:2d:${Math.floor(line / 32) * 32}:`;
      const cached = key ? [...textures.entries()].find(([k]) => k.startsWith(key))?.[1] : null;
      if (cached && line !== undefined) line = cached.lineMap[line - cached.start];
      text =
        path(n) + (line !== undefined ? ` · ${cached ? 'line' : 'display row'} ${line + 1}` : '');
      if (cached) {
        const symbol = (segments.get(n.id) || [])
          .filter((s) => s.startLine <= line && s.endLine > line)
          .at(-1);
        if (symbol?.name) text += ` · ${symbol.name}`;
      }
    } else {
      const f = visible.folders
        .filter((n) => p.x >= n.x && p.x < n.x + n.w && p.y >= n.y && p.y < n.y + n.h)
        .sort((a, b) => b.depth - a.depth)[0];
      if (f) text = path(f) + '/';
    }
  } else {
    hit = pick3D(visible.folds, flightCamera.eye, rayAt(pointer.x, pointer.y, flightCamera, w, h));
    if (hit) text = `${path(node(hit.node, false))} · line ${hit.line + 1}`;
  }
  const tip = $('tip');
  if (!text) {
    tip.style.display = 'none';
    return;
  }
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = Math.min(pointer.x + 17, w - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(pointer.y + 20, h - tip.offsetHeight - 60) + 'px';
}
function updateFlight(dt) {
  const b = basis(flightCamera.yaw, flightCamera.pitch);
  let direction = [0, 0, 0];
  for (const [key, vector] of [
    ['w', b.forward],
    ['s', mul(b.forward, -1)],
    ['a', mul(b.right, -1)],
    ['d', b.right],
    [' ', [0, 1, 0]],
    ['e', [0, 1, 0]],
    ['c', [0, -1, 0]],
    ['q', [0, -1, 0]],
  ])
    if (keys.has(key)) direction = add(direction, vector);
  const target = mul(norm(direction), keyboardFlightSpeed(speed, speedFactor, keys.has('shift'))),
    blend = 1 - Math.exp(-dt * 10);
  velocity = keys.has('x') ? [0, 0, 0] : velocity.map((v, i) => mix(v, target[i], blend));
  if (length(velocity) > speed * 0.0001) {
    flightCamera.eye = add(flightCamera.eye, mul(velocity, dt));
    dirty = true;
  }
}
// At most one asynchronous completion sample; the rendering loop never awaits it.
// Queue completion includes scheduling delay, so it is a pressure signal, not GPU time or FPS.
function sampleTextBudget(now, cpuMs, submittedAt) {
  if (mode !== '3d' || document.hidden || budgetSamplePending || now - lastBudgetSample < 500)
    return;
  budgetSamplePending = true;
  lastBudgetSample = now;
  const generation = budgetGeneration;
  gpu.device.queue
    .onSubmittedWorkDone()
    .then(() => {
      if (generation !== budgetGeneration || mode !== '3d' || document.hidden) return;
      if (
        gpu.textBudget.observe({
          now: performance.now(),
          cpuMs,
          queueMs: performance.now() - submittedAt,
        })
      ) {
        lastCollect = -Infinity;
        dirty = true;
      }
    })
    .catch(() => {})
    .finally(() => {
      budgetSamplePending = false;
    });
}
document.addEventListener('visibilitychange', () => {
  budgetGeneration++;
  gpu.textBudget?.observe({ visible: false });
  lastBudgetSample = -Infinity;
});
function frame(now) {
  requestAnimationFrame(frame);
  if (!ready) return;
  const start = performance.now(),
    dt = clamp((now - lastFrame) / 1000, 0, 0.05);
  lastFrame = now;
  if (animation) {
    const t = clamp((now - animation.start) / animation.duration, 0, 1);
    if (animation.mode === '2d')
      mapCamera = travel(animation.from, animation.to, t, Math.min(w, h) * 0.7);
    else {
      const f = ease(t);
      flightCamera = {
        eye: animation.from.eye.map((x, i) => mix(x, animation.to.eye[i], f)),
        yaw: mix(animation.from.yaw, animation.to.yaw, f),
        pitch: mix(animation.from.pitch, animation.to.pitch, f),
      };
    }
    dirty = true;
    if (t === 1) {
      animation = null;
      lastCollect = 0;
    }
  } else if (mode === '3d') updateFlight(dt);
  if (dirty) {
    if (now - lastCollect > 90) {
      visible =
        mode === '2d'
          ? collect2D(scene, mapCamera, w, h)
          : collect3D(scene, flightCamera, w, h, dpr, gpu.textBudget.current);
      collectTiles();
      lastCollect = now;
    }
    const submittedAt = performance.now();
    gpu.render(
      {
        mode,
        cam: mode === '2d' ? mapCamera : flightCamera,
        dpr,
        speed,
        far: Math.max(manifest.root[2], manifest.root[3]) * 30,
      },
      tileDraws,
      selectionPlanes(),
    );
    labels();
    tooltip();
    dirty = false;
    frameCount++;
    const cpuMs = performance.now() - start;
    frameTime += cpuMs;
    sampleTextBudget(now, cpuMs, submittedAt);
  }
  if (now - lastStats > 1000) {
    $('performance').textContent =
      `${frameCount} draws/s · CPU ${(frameTime / Math.max(1, frameCount)).toFixed(1)} ms · text ${(textureBytes / 1048576).toFixed(0)}/${gpu.textBudget.current.cacheBytes / 1048576} MiB`;
    $('stats').textContent =
      mode === '2d'
        ? `${manifest.stats.files.toLocaleString()} files · ${manifest.stats.lines.toLocaleString()} lines · ${tileDraws.length} text tiles`
        : `${scene.folds.toLocaleString()} resident folds · cruise ×${speedFactor.toFixed(1)} · ${tileDraws.length} text tiles · Auto ${gpu.textBudget.current.name}`;
    $('performance').title =
      `Automatic text detail: up to ${gpu.textBudget.current.maxDraws} tiles, ${gpu.textBudget.current.maxFiles} file candidates. Memory hints set conservative ceilings; foreground CPU and queue-completion pressure adjust the level. Cache budget excludes geometry and other browser memory.`;
    frameCount = 0;
    frameTime = 0;
    lastStats = now;
  }
}
async function boot() {
  const started = performance.now();
  resize();
  const snapshot = await openSnapshot();
  manifest = snapshot.manifest;
  if (manifest.previewSamples !== 16)
    throw Error('Unsupported source preview version; import this repository again.');
  $('repo-label').textContent = manifest.sourceRepo || 'Repository';
  $('snapshot-label').textContent = (manifest.commit || 'LOCAL').slice(0, 10);
  document.title = 'Atlas · ' + (manifest.sourceRepo || 'Repository');
  const coverage = manifest.coverage || {};
  $('coverage-status').textContent =
    `Syntax index: ${(coverage.parsed || 0) + (coverage.partial || 0)} / ${manifest.stats.files} files${coverage.symbolIndexLimited ? ' · symbol budget reached' : ''}`;
  const buffers = [snapshot.nodes, snapshot.paths, snapshot.previews];
  paths = new Uint8Array(buffers[1]);
  status('Preparing GPU source geometry in a worker…');
  const worker = new Worker(new URL('../render/geometry-worker.mjs', import.meta.url), {
    type: 'module',
  });
  const prepared = new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') status(data.message);
      if (data.type === 'geometry') resolve(data);
      if (data.type === 'error') reject(Error(data.message));
    };
    worker.onerror = (e) => reject(Error(e.message));
  });
  worker.postMessage({ nodes: buffers[0] }, [buffers[0]]);
  const geometry = await prepared;
  worker.terminate();
  scene = {
    view: new DataView(geometry.nodes),
    count: manifest.count,
    first: new Int32Array(geometry.first),
    next: new Int32Array(geometry.next),
    elevations: new Float64Array(geometry.elevations),
    bases: new Float64Array(geometry.bases),
    tops: new Float64Array(geometry.tops),
    folds: geometry.folds,
  };
  let maxId = 0;
  for (let i = 0; i < scene.count; i++)
    maxId = Math.max(maxId, scene.view.getUint32(i * 96 + 32, true));
  idIndex = new Int32Array(maxId + 1).fill(-1);
  for (let i = 0; i < scene.count; i++) idIndex[scene.view.getUint32(i * 96 + 32, true)] = i;
  const fileRecords = new Uint32Array(manifest.stats.files * 3);
  let fileOffset = 0;
  for (let i = 0; i < scene.count; i++) {
    const p = i * 96;
    if (scene.view.getUint32(p + 56, true)) {
      fileRecords[fileOffset++] = scene.view.getUint32(p + 32, true);
      fileRecords[fileOffset++] = scene.view.getUint32(p + 80, true);
      fileRecords[fileOffset++] = scene.view.getUint32(p + 84, true);
    }
  }
  const searchPaths = paths.slice().buffer;
  fileWorker.postMessage({ type: 'init', nodes: fileRecords, paths: searchPaths }, [
    fileRecords.buffer,
    searchPaths,
  ]);
  status('Uploading resident geometry and source previews to WebGPU…');
  await gpu.init(canvas, buffers[2], scene.count, fail);
  gpu.load(geometry.map, geometry.flights);
  gpu.resize(overlay.width, overlay.height);
  await fileReady;
  mapCamera = rootCamera();
  ready = true;
  $('query').disabled = false;
  for (const button of document.querySelectorAll('[data-mode]')) button.disabled = false;
  $('loading').style.display = 'none';
  telemetry.track('viewer_ready', {
    source: manifest.importSource,
    seconds: (performance.now() - started) / 1000,
    files: manifest.stats.files,
  });
  if (manifest.importSource === 'github' && manifest.publicRepository)
    telemetry.track('repository_viewed', { source: 'github', repo: manifest.publicRepository });
  mark();
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has('file')) {
    const id = Number(params.get('file'));
    if (idIndex[id] >= 0)
      navigate({ id, line: Math.max(0, Number(params.get('line') || 1) - 1), column: 0 });
  }
}
requestAnimationFrame(frame);
boot().catch(fail);
