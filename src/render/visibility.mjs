import {
  DEPTH,
  FOV,
  readNode,
  surface,
  foldAt,
  basis,
  add,
  sub,
  mul,
  dot,
  cross,
  length,
  clamp,
} from './core.mjs';

const MAX_VISITS = 16000,
  MAX_FILES = 96,
  MAX_FOLDERS = 384;
const MAX_FOLDS = 4000,
  MAX_FOLD_VISITS = 8000;

// Frame-local best-first traversal; no retained whole-scene text or object graph.
class MaxHeap {
  constructor() {
    this.items = [];
  }
  push(item) {
    const a = this.items;
    let i = a.length;
    a.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].score >= item.score) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items,
      result = a[0],
      end = a.pop();
    if (!a.length) return result;
    let i = 0;
    while (i * 2 + 1 < a.length) {
      let child = i * 2 + 1;
      if (child + 1 < a.length && a[child + 1].score > a[child].score) child++;
      if (a[child].score <= end.score) break;
      a[i] = a[child];
      i = child;
    }
    a[i] = end;
    return result;
  }
  get size() {
    return this.items.length;
  }
}

function validScene(scene) {
  return scene?.view && scene.count > 0;
}
function validIndex(scene, index) {
  return Number.isInteger(index) && index >= 0 && index < scene.count;
}
function empty() {
  return { folders: [], files: [], folds: [], visited: 0, truncated: false };
}
function scoreBounds(rect, w, h) {
  const left = Math.max(0, rect.x),
    top = Math.max(0, rect.y);
  const right = Math.min(w, rect.x + rect.w),
    bottom = Math.min(h, rect.y + rect.h);
  if (right <= left || bottom <= top) return null;
  const area = (right - left) * (bottom - top);
  const dx = ((left + right) / 2 - w / 2) / w,
    dy = ((top + bottom) / 2 - h / 2) / h;
  return { screenBounds: rect, screenArea: area, score: area / (1 + 12 * (dx * dx + dy * dy)) };
}

/** Decoding siblings also consumes the visit budget. Flat enormous directories
 * can exhaust it; first/next alone cannot guarantee sublinear spatial lookup.
 * Normal nested source trees are culled before their children are decoded.
 */
function traverse(scene, display, candidate, accept) {
  const heap = new MaxHeap();
  let visited = 0,
    truncated = false;
  function enqueue(index) {
    if (!validIndex(scene, index)) return;
    if (visited >= MAX_VISITS) {
      truncated = true;
      return;
    }
    visited++;
    const node = readNode(scene.view, index, display),
      extra = candidate(node);
    if (extra) heap.push({ ...node, ...extra, display });
  }
  enqueue(scene.root ?? 0);
  while (heap.size) {
    const node = heap.pop();
    accept(node);
    if (node.kind || node.descend === false) continue;
    let index = scene.first[node.index];
    while (validIndex(scene, index)) {
      if (visited >= MAX_VISITS) {
        truncated = true;
        break;
      }
      enqueue(index);
      index = scene.next[index];
    }
  }
  return { visited, truncated };
}

export function collect2D(scene, cam, w, h) {
  const result = empty();
  if (!validScene(scene) || !(cam.scale > 0) || !(w > 0 && h > 0)) return result;
  const candidate = (n) => {
    const rect = {
      x: (n.x - cam.x) * cam.scale + w / 2,
      y: (n.y - cam.y) * cam.scale + h / 2,
      w: n.w * cam.scale,
      h: n.h * cam.scale,
    };
    const score = scoreBounds(rect, w, h);
    if (!score) return null;
    // Even a one-row descendant needs >3.8 cells across and five rows of height.
    return { ...score, descend: rect.w > 3.8 && rect.h > 5 };
  };
  Object.assign(
    result,
    traverse(scene, true, candidate, (n) => {
      if (n.kind) {
        const projectedLineHeight = surface(n).lineHeight * cam.scale;
        if (n.lines > 0 && projectedLineHeight > 0.5)
          result.files.push({ ...n, projectedLineHeight });
      } else if (n.screenBounds.w > 12 && n.screenBounds.h > 12) result.folders.push(n);
    }),
  );
  result.files.sort((a, b) => b.score - a.score);
  result.files.length = Math.min(result.files.length, MAX_FILES);
  result.folders.sort((a, b) => b.score - a.score);
  result.folders.length = Math.min(result.folders.length, MAX_FOLDERS);
  return result;
}

/** World-coordinate picking, with half-open edges matching the treemap. */
export function pick2D(scene, x, y) {
  if (!validScene(scene) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const stack = [];
  let visited = 0,
    best = null;
  function enqueue(index) {
    if (!validIndex(scene, index) || visited >= MAX_VISITS) return;
    const n = readNode(scene.view, index, true);
    visited++;
    if (x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h) stack.push(n);
  }
  enqueue(scene.root ?? 0);
  while (stack.length) {
    const n = stack.pop();
    if (n.kind) {
      if (!best || n.depth > best.depth) best = { ...n, display: true };
      continue;
    }
    let child = scene.first[n.index];
    while (validIndex(scene, child) && visited < MAX_VISITS) {
      enqueue(child);
      child = scene.next[child];
    }
  }
  return best;
}

function cameraBasis(cam) {
  const calculated = basis(cam.yaw || 0, cam.pitch || 0);
  return {
    right: cam.right || calculated.right,
    up: cam.up || calculated.up,
    forward: cam.forward || calculated.forward,
  };
}

/** Keep scalar fold fields unchanged. Oriented text uses origin +
 * u*across + v*down; u/v always increase with the displayed source column/row.
 */
export function orientFold(f, cam) {
  const b = cameraBasis(cam);
  let origin = [f.x, f.y, f.z],
    across = [f.w, 0, 0],
    down = [0, f.dy, f.dz];
  const flipX = dot(across, b.right) < 0,
    flipY = dot(down, b.up) > 0;
  if (flipX) {
    origin = add(origin, across);
    across = across.map((value) => (value ? -value : 0));
  }
  if (flipY) {
    origin = add(origin, down);
    down = down.map((value) => (value ? -value : 0));
  }
  return { ...f, origin, across, down, flipX, flipY };
}

function frustum(cam, w, h) {
  const b = cameraBasis(cam),
    tangent = Math.tan(FOV / 2),
    horizontal = (tangent * w) / h;
  const focal = h / (2 * tangent),
    near = Math.max(1e-12, cam.near || 1e-12);
  return {
    ...b,
    focal,
    near,
    point(p) {
      const d = sub(p, cam.eye);
      return [dot(d, b.right), dot(d, b.up), dot(d, b.forward)];
    },
    sphere(center, radius) {
      const d = sub(center, cam.eye),
        z = dot(d, b.forward),
        x = dot(d, b.right),
        y = dot(d, b.up);
      if (
        z + radius <= near ||
        Math.abs(x) > z * horizontal + radius * Math.sqrt(1 + horizontal * horizontal) ||
        Math.abs(y) > z * tangent + radius * Math.sqrt(1 + tangent * tangent)
      )
        return null;
      const viewDepth = Math.max(near, z - radius);
      // A near-plane intersection can project arbitrarily widely. Whole viewport
      // is a conservative ranking bound; individual folds are clipped below.
      const rx = ((radius * (1 + Math.abs(x) / Math.max(near, z))) / viewDepth) * focal;
      const ry = ((radius * (1 + Math.abs(y) / Math.max(near, z))) / viewDepth) * focal;
      const rect =
        z <= radius
          ? { x: 0, y: 0, w, h }
          : {
              x: w / 2 + (x / z) * focal - rx,
              y: h / 2 - (y / z) * focal - ry,
              w: 2 * rx,
              h: 2 * ry,
            };
      const score = scoreBounds(rect, w, h);
      return score ? { ...score, viewDepth, centerDepth: z } : null;
    },
  };
}

function verticalBounds(scene, n) {
  const elevation = scene.elevations?.[n.index] || 0;
  if (Number.isFinite(scene.bases?.[n.index]) && Number.isFinite(scene.tops?.[n.index]))
    return [scene.bases[n.index], scene.tops[n.index]];
  if (n.kind) {
    const s = surface(n),
      chunk = Math.max(96, Math.ceil(n.lines / 2048));
    return [
      elevation + 3 * s.lineHeight,
      elevation +
        3 * s.lineHeight +
        Math.min(chunk, s.rows) * s.lineHeight * Math.sqrt(1 - DEPTH * DEPTH),
    ];
  }
  // Legacy callers without worker aggregates remain conservative. This can be
  // deliberately loose; supplying bases/tops is essential for large scenes.
  const remainingDepth = Math.max(0, (scene.maxDepth ?? scene.count) - n.depth);
  return [elevation, elevation + n.h + 0.012 * Math.min(n.w, n.h) * remainingDepth];
}

function foldBounds(f, view, w, h) {
  let polygon = [
    f.origin,
    add(f.origin, f.across),
    add(add(f.origin, f.across), f.down),
    add(f.origin, f.down),
  ].map((p) => view.point(p));
  const clipped = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      aIn = a[2] >= view.near,
      bIn = b[2] >= view.near;
    if (aIn) clipped.push(a);
    if (aIn !== bIn) {
      const t = (view.near - a[2]) / (b[2] - a[2]);
      clipped.push(add(a, mul(sub(b, a), t)));
    }
  }
  if (clipped.length < 3) return null;
  const points = clipped.map((p) => [
    w / 2 + (p[0] / Math.max(view.near, p[2])) * view.focal,
    h / 2 - (p[1] / Math.max(view.near, p[2])) * view.focal,
  ]);
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const rect = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
  const score = scoreBounds(rect, w, h);
  if (!score) return null;
  // Upper bound on projected row footprint keeps near-plane and foreshortened
  // source conservative; the renderer can make finer per-tile LOD decisions.
  const viewDepth = Math.max(view.near, Math.min(...clipped.map((p) => p[2])));
  return { ...score, viewDepth, projectedLineHeight: (f.lineHeight * view.focal) / viewDepth };
}

export function collect3D(scene, cam, w, h, pixelRatio = 1, budget = {}) {
  const result = empty();
  if (!validScene(scene) || !cam.eye || !(w > 0 && h > 0)) return result;
  const view = frustum(cam, w, h),
    minPixels = budget.minPixels ?? 0.8;
  const candidate = (n) => {
    const [base, top] = verticalBounds(scene, n);
    const center = [n.x + n.w / 2, (base + top) / 2, (n.y + n.h / 2) * DEPTH];
    const radius = Math.hypot(n.w, top - base, n.h * DEPTH) / 2;
    const score = view.sphere(center, radius);
    return score
      ? {
          ...score,
          elevation: scene.elevations?.[n.index] || 0,
          descend: Math.hypot(score.screenBounds.w, score.screenBounds.h) > 1,
        }
      : null;
  };
  Object.assign(
    result,
    traverse(scene, false, candidate, (n) => {
      if (n.kind) {
        const projectedLineHeight = (surface(n).lineHeight * view.focal) / n.viewDepth;
        if (n.lines > 0 && projectedLineHeight * pixelRatio > minPixels)
          result.files.push({ ...n, projectedLineHeight });
      } else if (n.screenBounds.w > 12 && n.screenBounds.h > 12) result.folders.push(n);
    }),
  );
  result.files.sort((a, b) => b.score - a.score);
  result.files.length = Math.min(
    result.files.length,
    clamp(Math.floor(budget.maxFiles || MAX_FILES * 2), 1, 640),
  );
  result.folders.sort((a, b) => b.score - a.score);
  result.folders.length = Math.min(result.folders.length, MAX_FOLDERS);
  let foldVisits = 0;
  for (const n of result.files) {
    const s = surface(n),
      chunk = Math.max(96, Math.ceil(n.lines / 2048));
    for (let panel = 0; panel < s.panels && foldVisits < MAX_FOLD_VISITS; panel++) {
      const body = s.panel(panel),
        count = Math.ceil(body.count / chunk);
      // Begin near the camera's source-depth address, then inspect both sides.
      const near = clamp(
        Math.floor((cam.eye[2] / DEPTH - body.y) / (s.lineHeight * chunk)),
        0,
        Math.max(0, count - 1),
      );
      for (let distance = 0; distance < count && foldVisits < MAX_FOLD_VISITS; distance++) {
        const indices = distance === 0 ? [near] : [near - distance, near + distance];
        for (const index of indices) {
          if (index < 0 || index >= count || foldVisits >= MAX_FOLD_VISITS) continue;
          foldVisits++;
          const fold = orientFold(foldAt(n, body.start + index * chunk, n.elevation), cam);
          const projected = foldBounds(fold, view, w, h);
          if (projected && projected.projectedLineHeight * pixelRatio > minPixels)
            result.folds.push({ ...fold, ...projected });
        }
      }
    }
    if (foldVisits >= MAX_FOLD_VISITS) {
      result.truncated = true;
      break;
    }
  }
  result.folds.sort((a, b) => b.score - a.score);
  result.folds.length = Math.min(result.folds.length, MAX_FOLDS);
  result.foldVisits = foldVisits;
  return result;
}

/** Closest forward ray hit, using the same oriented UV frame as visible text. */
export function pick3D(folds, eye, ray) {
  let best = null;
  for (const f of folds) {
    const origin = f.origin || [f.x, f.y, f.z],
      across = f.across || [f.w, 0, 0],
      down = f.down || [0, f.dy, f.dz];
    const normal = cross(across, down),
      normalLength = length(normal),
      denominator = dot(normal, ray);
    if (
      !normalLength ||
      Math.abs(denominator) <= normalLength * Math.max(1e-30, length(ray)) * 1e-10
    )
      continue;
    const distance = dot(normal, sub(origin, eye)) / denominator;
    if (distance <= 0 || (best && distance >= best.distance)) continue;
    const point = add(eye, mul(ray, distance)),
      relative = sub(point, origin);
    const u = dot(relative, across) / dot(across, across),
      v = dot(relative, down) / dot(down, down);
    if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
    const columns = Math.min(f.columns || 0, length(across) / Math.max(1e-30, f.lineHeight * 0.45));
    best = {
      id: f.id,
      node: f.node,
      panel: f.panel,
      line: f.start + Math.min(f.count - 1, Math.floor(v * f.count + 1e-9)),
      column: Math.min(Math.max(0, Math.ceil(columns) - 1), Math.floor(u * columns + 1e-9)),
      distance,
      point,
      fold: f,
      u,
      v,
    };
  }
  return best;
}
