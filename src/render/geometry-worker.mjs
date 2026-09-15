import { readNode, surface, foldAt, RISE } from './core.mjs';
import { assertGeometryBudget } from './geometry-budget.mjs';
const LIMIT = 500000;
function write(array, i, n, origin, w, v, meta, shape) {
  const f = new Float32Array(array, i * 96, 24),
    u = new Uint32Array(array, i * 96, 24);
  for (let j = 0; j < 3; j++) {
    f[j] = origin[j];
    f[4 + j] = origin[j] - f[j];
  }
  f[3] = w;
  f.set(v, 8);
  f[12] = (n.color & 255) / 255;
  f[13] = ((n.color >>> 8) & 255) / 255;
  f[14] = ((n.color >>> 16) & 255) / 255;
  f[15] = 1;
  u.set(meta, 16);
  f.set(shape, 20);
}
onmessage = ({ data }) => {
  try {
    const { nodes } = data,
      view = new DataView(nodes),
      count = nodes.byteLength / 96;
    const first = new Int32Array(count).fill(-1),
      next = new Int32Array(count).fill(-1),
      elevations = new Float64Array(count),
      bases = new Float64Array(count).fill(Infinity),
      tops = new Float64Array(count).fill(-Infinity);
    let files = 0,
      folds = 0,
      folders = 0;
    for (let i = 0; i < count; i++) {
      const n = readNode(view, i);
      if (n.parent !== 0xffffffff) {
        next[i] = first[n.parent];
        first[n.parent] = i;
        const p = readNode(view, n.parent);
        elevations[i] = elevations[n.parent] + (n.kind ? 0 : Math.min(p.w, p.h) * 0.012);
      }
      if (!n.kind) folders++;
      if (n.kind) {
        files++;
        if (n.lines) {
          const s = surface(n),
            chunk = Math.max(96, Math.ceil(n.lines / 2048));
          bases[i] = elevations[i] + 3 * s.lineHeight;
          tops[i] = bases[i] + Math.min(chunk, s.rows) * s.lineHeight * RISE;
          for (let p = 0; p < n.panels; p++) folds += Math.ceil(s.panel(p).count / chunk);
        }
      }
    }
    for (let i = count - 1; i >= 0; i--) {
      const parent = view.getUint32(i * 96 + 36, true);
      if (!Number.isFinite(bases[i])) {
        bases[i] = elevations[i];
        tops[i] = elevations[i];
      }
      if (parent !== 0xffffffff) {
        bases[parent] = Math.min(bases[parent], bases[i]);
        tops[parent] = Math.max(tops[parent], tops[i]);
      }
    }
    postMessage({ type: 'progress', message: `Preparing ${folds.toLocaleString()} source folds…` });
    assertGeometryBudget(files, folds, folders);
    const total = folds + folders;
    const map = new ArrayBuffer(files * 96),
      flights = Array.from(
        { length: Math.ceil(total / LIMIT) },
        (_, i) => new ArrayBuffer(Math.min(LIMIT, total - i * LIMIT) * 96),
      );
    let m = 0,
      f = 0;
    for (let i = 0; i < count; i++) {
      const n = readNode(view, i);
      if (!n.kind) {
        write(
          flights[Math.floor(f / LIMIT)],
          f % LIMIT,
          n,
          [n.x, elevations[i], n.y * 0.34],
          n.w,
          [0, n.h * 0.34, 1, 1],
          [i, 0, 0, 0],
          [1, 1, 0, 0],
        );
        f++;
        continue;
      }
      const d = readNode(view, i, true),
        s = surface(d);
      write(
        map,
        m++,
        d,
        [d.x, d.y, 0],
        d.w,
        [s.lineHeight, s.panelWidth, d.columns, d.h],
        [i, d.preview, d.lines, d.panels],
        [0, 0, 0, 0],
      );
      if (!n.lines) continue;
      const raw = surface(n),
        chunk = Math.max(96, Math.ceil(n.lines / 2048));
      for (let p = 0; p < raw.panels; p++) {
        const b = raw.panel(p);
        for (let row = b.start; row < b.start + b.count; row += chunk) {
          const g = foldAt(n, row, elevations[i]);
          write(
            flights[Math.floor(f / LIMIT)],
            f % LIMIT,
            n,
            [g.x, g.y, g.z],
            g.w,
            [g.dy, g.dz, g.lineHeight, g.columns],
            [i, n.preview + p * 16, g.local, g.count],
            [b.count, 0, 0, 0],
          );
          f++;
        }
      }
    }
    postMessage(
      {
        type: 'geometry',
        nodes,
        map,
        flights,
        elevations: elevations.buffer,
        bases: bases.buffer,
        tops: tops.buffer,
        first: first.buffer,
        next: next.buffer,
        files,
        folds,
      },
      [
        nodes,
        map,
        ...flights,
        elevations.buffer,
        bases.buffer,
        tops.buffer,
        first.buffer,
        next.buffer,
      ],
    );
  } catch (error) {
    postMessage({ type: 'error', message: error.stack || String(error) });
  }
};
