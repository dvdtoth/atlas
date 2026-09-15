import { githubArchiveURL } from './repository-links.mjs';
import { ClientStore } from '../index/client-store.mjs';
import { WorkerRPC } from '../shared/worker-rpc.mjs';
import {
  ImportProgressTimer,
  formatDuration,
  formatImportETA,
  importStage,
  importMessage,
} from '../import/import-progress.mjs';
import { telemetry, setAnalyticsConsent, savedConsent } from '../shared/telemetry.mjs';
const $ = (id) => document.getElementById(id);
let busy = false,
  rpc = null,
  projectId = null,
  lastProgress = null,
  paintPending = false;
const storePromise = ClientStore.open();
storePromise.catch((error) => showError(error));
const bytes = (n) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GiB' : (n / 1024 ** 2).toFixed(1) + ' MiB';
const projectURL = (id) => 'viewer.html?project=' + encodeURIComponent(id);
let importTimer = null,
  timerInterval = null,
  currentImportStage = 'cache',
  lastProgressPaint = -Infinity;
function paintTiming() {
  if (!busy || !importTimer) return;
  const state = importTimer.snapshot();
  $('import-elapsed').textContent = formatDuration(state.elapsedSeconds);
  $('import-eta').textContent = formatImportETA(state);
}
function setTiming(active) {
  clearInterval(timerInterval);
  timerInterval = null;
  importTimer = active ? new ImportProgressTimer() : null;
  if (active) {
    paintTiming();
    timerInterval = setInterval(paintProgress, 1000);
  }
}
function showError(error) {
  $('import-error').hidden = false;
  $('import-error').textContent = error.message || String(error);
}
function setBusy(value) {
  busy = value;
  setTiming(value);
  $('import-button').disabled = value;
  $('repository').disabled = value;
  $('ref').disabled = value;
  $('folder-input').disabled = value;
  $('zip-input').disabled = value;
  $('choose-zip').disabled = value;
  $('zip-drop').setAttribute('aria-disabled', String(value));
  $('progress-panel').hidden = !value;
  if (value) {
    $('import-error').hidden = true;
    $('cancel-import').disabled = false;
    $('cancel-import').textContent = 'Cancel';
  }
}
function paintProgress() {
  if (!busy) return;
  const p = lastProgress || {},
    counts = p.work || p;
  lastProgressPaint = performance.now();
  $('progress-title').textContent = 'Preparing your code map';
  $('progress-message').textContent = importMessage(currentImportStage);
  $('import-stages').setAttribute('data-stage', currentImportStage);
  for (const step of ['cache', 'build']) {
    const el = $('stage-' + step);
    if (step === currentImportStage) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  }
  if (counts.total > 0) {
    $('progress').max = counts.total;
    $('progress').value = Math.min(counts.completed || 0, counts.total);
  } else $('progress').removeAttribute('value');
  $('progress-detail').textContent = [
    counts.total
      ? `${(counts.completed || 0).toLocaleString()} / ${counts.total.toLocaleString()}`
      : '',
    p.bytes ? bytes(p.bytes) : '',
    p.symbols ? `${p.symbols.toLocaleString()} symbols` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  paintTiming();
}
function progress(value) {
  if (!busy) return;
  importTimer?.update(value);
  lastProgress = { ...lastProgress, ...value };
  const next = importStage(value, currentImportStage),
    changed = next !== currentImportStage;
  currentImportStage = next;
  if (paintPending || (!changed && performance.now() - lastProgressPaint < 1000)) return;
  paintPending = true;
  requestAnimationFrame(() => {
    paintPending = false;
    paintProgress();
  });
}
async function refreshLibrary() {
  try {
    const store = await storePromise,
      projects = await store.projects();
    if (!projects.length) {
      $('projects').replaceChildren(
        Object.assign(document.createElement('p'), {
          className: 'empty',
          textContent:
            'Maps you build appear here. Reopen a saved snapshot without downloading the repository again.',
        }),
      );
    } else {
      const frag = document.createDocumentFragment();
      for (const p of projects) {
        const row = document.createElement('div');
        row.className = 'project';
        const info = document.createElement('div');
        info.className = 'info';
        const name = document.createElement('strong');
        name.className = 'project-name';
        name.textContent = p.fullName || 'Repository';
        const detail = document.createElement('p');
        detail.textContent =
          p.state === 'ready'
            ? `${p.stats.files.toLocaleString()} files · ${(p.stats.lines || 0).toLocaleString()} lines · ${(p.commit || '').slice(0, 10)} · ${p.stats.skipped || 0} skipped${p.finishedAt > p.createdAt ? ' · built in ' + ((p.finishedAt - p.createdAt) / 1000).toFixed(1) + ' s' : ''}`
            : p.state === 'importing'
              ? 'Import in progress or interrupted. Keep its original tab open, or remove it to reclaim space.'
              : p.state === 'cancelled'
                ? 'Import cancelled. Partial source was removed.'
                : p.error || 'Import failed.';
        if (p.state === 'failed') detail.className = 'failure';
        info.append(name, detail);
        row.append(info);
        if (p.state === 'ready') {
          const open = document.createElement('a');
          open.className = 'open';
          open.textContent = 'Open map ↗';
          open.href = projectURL(p.id);
          open.onclick = () => telemetry.track('cache_opened');
          row.append(open);
        }
        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = 'Remove';
        remove.title = 'Remove this snapshot from this browser';
        remove.disabled = busy;
        remove.onclick = async () => {
          remove.disabled = true;
          try {
            await store.deleteProject(p.id);
            await refreshLibrary();
          } catch (e) {
            showError(e);
            remove.disabled = false;
          }
        };
        row.append(remove);
        frag.append(row);
      }
      $('projects').replaceChildren(frag);
    }
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage)
      $('storage-summary').textContent = bytes(estimate.usage) + ' ON THIS DEVICE';
  } catch (error) {
    showError(error);
  }
}
async function runImport(input, files = null, archive = null) {
  if (busy) return;
  if (!navigator.gpu) {
    showError(
      Error(
        'This browser does not expose WebGPU. Use a current WebGPU-capable desktop browser over HTTPS or localhost.',
      ),
    );
    return;
  }
  lastProgress = null;
  currentImportStage = 'cache';
  lastProgressPaint = -Infinity;
  setBusy(true);
  const id = (projectId = crypto.randomUUID());
  progress({ message: 'Preparing browser workers…' });
  let worker = null;
  try {
    worker = rpc = new WorkerRPC(new URL('../import/project-worker.mjs', import.meta.url));
    telemetry.track('import_started', { source: archive ? 'zip' : files ? 'folder' : 'github' });
    // Library rendering and storage-usage estimates are optional UI work. Never
    // make worker startup (or cancellation cleanup) depend on them completing.
    void refreshLibrary();
    const result = await worker.request(
      'import',
      { projectId: id, input, ref: $('ref').value.trim(), files, archive },
      { onProgress: progress, initialResponseTimeoutMs: 15_000 },
    );
    telemetry.track('import_ready', {
      files: result.stats.files,
      bytes: result.stats.bytes || 0,
      seconds: result.seconds || 0,
    });
    setBusy(false);
    location.assign(projectURL(result.projectId));
  } catch (error) {
    if (error.name === 'AbortError') {
      telemetry.track('import_cancelled');
      $('import-error').hidden = true;
    } else {
      showError(error);
      telemetry.track('import_failed', {
        reason: /storage|quota/i.test(error.message)
          ? 'storage'
          : /limit|budget/i.test(error.message)
            ? 'limit'
            : 'unknown',
      });
    }
    setBusy(false);
    void refreshLibrary();
  } finally {
    worker?.close();
    if (rpc === worker) {
      rpc = null;
      projectId = null;
    }
  }
}
function updateArchiveLink() {
  try {
    $('download-archive').href = githubArchiveURL($('repository').value, $('ref').value);
    $('download-archive').removeAttribute('aria-disabled');
  } catch {
    $('download-archive').removeAttribute('href');
    $('download-archive').setAttribute('aria-disabled', 'true');
  }
}
$('repository').addEventListener('input', updateArchiveLink);
$('ref').addEventListener('input', updateArchiveLink);
$('download-archive').onclick = (e) => {
  try {
    e.currentTarget.href = githubArchiveURL($('repository').value, $('ref').value);
  } catch (error) {
    e.preventDefault();
    showError(error);
  }
};
updateArchiveLink();
$('import-form').onsubmit = (e) => {
  e.preventDefault();
  runImport($('repository').value.trim());
};
function openZip(files) {
  if (busy) return;
  if (files.length !== 1) {
    showError(Error('Choose one repository ZIP at a time.'));
    return;
  }
  const archive = files[0];
  if (!/\.zip$/i.test(archive.name)) {
    showError(Error('Choose a .zip repository archive.'));
    return;
  }
  runImport(archive.name.replace(/\.zip$/i, '') || 'Local ZIP', null, archive);
}
$('choose-zip').onclick = () => $('zip-input').click();
$('zip-input').onchange = (e) => {
  const files = Array.from(e.target.files);
  e.target.value = '';
  if (files.length) openZip(files);
};
let dragDepth = 0;
$('zip-drop').ondragenter = (e) => {
  e.preventDefault();
  if (!busy) {
    dragDepth++;
    $('zip-drop').setAttribute('data-dragging', 'true');
  }
};
$('zip-drop').ondragover = (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
};
$('zip-drop').ondragleave = (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('zip-drop').removeAttribute('data-dragging');
  }
};
$('zip-drop').ondrop = (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('zip-drop').removeAttribute('data-dragging');
  openZip(Array.from(e.dataTransfer.files));
};
// Dropping outside the target must not navigate away from an active map import.
for (const type of ['dragover', 'drop'])
  window.addEventListener(type, (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
  });
$('folder-input').onchange = (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  const root = (files[0].webkitRelativePath || 'Local folder').split('/')[0];
  runImport(root, files);
  e.target.value = '';
};
$('cancel-import').onclick = async () => {
  if (!rpc || !projectId) return;
  $('cancel-import').disabled = true;
  $('cancel-import').textContent = 'Cancelling…';
  const id = projectId;
  rpc.close(new DOMException('Import cancelled', 'AbortError'));
  try {
    const store = await storePromise;
    const p = await store.project(id);
    if (p && p.state !== 'ready') {
      await store.updateProject(id, { state: 'cancelled' });
      await store.clearDocuments(id);
    }
  } catch (error) {
    showError(error);
  }
  void refreshLibrary();
};
$('analytics-consent').checked = savedConsent();
$('analytics-consent').disabled = !telemetry.configured || telemetry.privacyBlocked;
$('analytics-consent').onchange = (e) => setAnalyticsConsent(e.target.checked);
$('analytics-note').textContent = telemetry.privacyBlocked
  ? 'Analytics disabled by your browser privacy preference.'
  : telemetry.configured
    ? 'Optional Umami events: coarse usage counts and timings. No code, repository names, search terms, or session replay.'
    : 'Analytics are off. This installation has no analytics endpoint configured.';
if (!navigator.gpu) {
  $('compatibility').hidden = false;
  $('compatibility').textContent =
    'WebGPU is unavailable here. Atlas needs a WebGPU-capable desktop browser and HTTPS (or localhost).';
}
window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
telemetry.track('app_opened');
refreshLibrary();
// A small source-shaped illustration, not repository data or a raster placeholder.
const svg = $('map-illustration'),
  ns = 'http://www.w3.org/2000/svg';
let seed = 211;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
function rect(x, y, w, h, fill, stroke) {
  const r = document.createElementNS(ns, 'rect');
  for (const [k, v] of Object.entries({
    x,
    y,
    width: w,
    height: h,
    fill,
    stroke,
    'stroke-width': 0.6,
  }))
    r.setAttribute(k, v);
  svg.append(r);
}
function block(x, y, w, h, depth, family) {
  const colors = ['#498b9f', '#8a6bba', '#b0985c', '#5b9d87'];
  if (depth > 0) {
    const wide = w > h,
      ratio = 0.32 + rand() * 0.3;
    if (wide) {
      block(x, y, w * ratio, h, depth - 1, family);
      block(x + w * ratio, y, w * (1 - ratio), h, depth - 1, family);
    } else {
      block(x, y, w, h * ratio, depth - 1, family);
      block(x, y + h * ratio, w, h * (1 - ratio), depth - 1, family);
    }
    if (depth > 2) rect(x, y, w, h, 'none', '#356775');
    return;
  }
  rect(x + 1, y + 1, w - 2, h - 2, '#0d1d25', colors[family]);
  for (let row = 5; row < h - 4; row += 3) {
    const indent = rand() * w * 0.15;
    rect(
      x + 4 + indent,
      y + row,
      Math.max(1, (w - 9 - indent) * (0.15 + rand() * 0.8)),
      0.6,
      colors[family] + '80',
      'none',
    );
  }
}
block(8, 14, 290, 348, 7, 0);
block(301, 14, 170, 224, 6, 1);
block(301, 241, 170, 121, 5, 2);
