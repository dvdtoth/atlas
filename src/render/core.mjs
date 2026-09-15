export const DEPTH = 0.34,
  RISE = Math.sqrt(1 - DEPTH * DEPTH),
  FOV = (70 * Math.PI) / 180;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const ease = (t) => t * t * t * (10 + t * (-15 + 6 * t));
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const mul = (a, s) => a.map((x) => x * s);
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export const length = (a) => Math.hypot(...a);
export const norm = (a) => mul(a, 1 / (length(a) || 1));
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export function surface(n) {
  const lines = Math.max(1, n.lines),
    panels = clamp(n.panels || 1, 1, 32),
    rows = Math.ceil(lines / panels),
    columns = Math.min(4096, n.columns || 0);
  const required = panels * ((columns + 4) * 0.45 + 2) + (panels - 1) * 2;
  const lineHeight = Math.max(
    1e-20,
    Math.min(n.h / (rows + (panels === 1 ? 4 : 6)), n.w / required),
  );
  const panelWidth = (n.w - (panels - 1) * 2 * lineHeight) / panels,
    top = (panels === 1 ? 2 : 4) * lineHeight;
  return {
    lineHeight,
    panelWidth,
    panels,
    rows,
    columns,
    panel(p) {
      const q = Math.floor(lines / panels),
        r = lines % panels,
        start = p * q + Math.min(p, r),
        count = q + (p < r ? 1 : 0);
      return {
        x: n.x + p * (panelWidth + 2 * lineHeight) + lineHeight,
        y: n.y + top,
        w: Math.max(0, panelWidth - 2 * lineHeight),
        h: count * lineHeight,
        start,
        count,
      };
    },
  };
}
export function sourceAt(n, x, y) {
  const s = surface(n),
    p = clamp(Math.floor((x - n.x) / (s.panelWidth + 2 * s.lineHeight)), 0, s.panels - 1),
    b = s.panel(p);
  if (x < b.x || x > b.x + b.w || y < b.y || y >= b.y + b.h) return null;
  return {
    line: Math.min(n.lines - 1, b.start + Math.floor((y - b.y) / s.lineHeight)),
    column: clamp(Math.floor((x - b.x) / (s.lineHeight * 0.45) + 1e-8), 0, 4095),
    panel: p,
  };
}
export function panelFor(s, line) {
  for (let p = 0; p < s.panels; p++) {
    const b = s.panel(p);
    if (line < b.start + b.count) return p;
  }
  return s.panels - 1;
}
export function foldAt(n, line, elevation = 0) {
  const s = surface(n),
    p = panelFor(s, line),
    b = s.panel(p),
    chunk = Math.max(96, Math.ceil(n.lines / 2048));
  const local = Math.max(0, line - b.start),
    fold = Math.floor(local / chunk),
    start = fold * chunk,
    count = Math.min(chunk, b.count - start);
  const h = s.lineHeight,
    crest = Math.min(chunk, b.count) * h * RISE;
  return {
    id: n.id,
    node: n.index,
    panel: p,
    start: b.start + start,
    count,
    x: b.x,
    y: elevation + 3 * h + (fold % 2 === 0 ? crest : 0),
    z: (b.y + start * h) * DEPTH,
    w: Math.min(b.w, Math.max(1, n.columns) * 0.45 * h),
    dy: (fold % 2 === 0 ? -1 : 1) * count * h * RISE,
    dz: count * h * DEPTH,
    lineHeight: h,
    columns: n.columns,
    local: start,
    panelRows: b.count,
  };
}
export function basis(yaw, pitch) {
  return {
    forward: [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)],
    right: [Math.cos(yaw), 0, Math.sin(yaw)],
    up: [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)],
  };
}
export function look(eye, target) {
  const d = norm(sub(target, eye));
  return { yaw: Math.atan2(d[0], -d[2]), pitch: Math.asin(clamp(d[1], -1, 1)) };
}
export function project(p, cam, w, h) {
  const b = basis(cam.yaw, cam.pitch),
    d = sub(p, cam.eye),
    z = dot(d, b.forward);
  if (z <= 1e-12) return null;
  const f = h / (2 * Math.tan(FOV / 2));
  return { x: w / 2 + (dot(d, b.right) / z) * f, y: h / 2 - (dot(d, b.up) / z) * f, z };
}
export function rayAt(x, y, cam, w, h) {
  const b = basis(cam.yaw, cam.pitch),
    t = (2 * Math.tan(FOV / 2)) / h;
  return norm(add(add(b.forward, mul(b.right, (x - w / 2) * t)), mul(b.up, (h / 2 - y) * t)));
}
const logCosh = (x) => Math.abs(x) + Math.log1p(Math.exp(-2 * Math.abs(x))) - Math.log(2);
const logSinh = (x) => x + Math.log(-Math.expm1(-2 * x)) - Math.log(2);
export function travel(a, b, time, span) {
  if (time <= 0) return { ...a };
  if (time >= 1) return { ...b };
  const t = ease(time),
    dist = Math.hypot(b.x - a.x, b.y - a.y);
  let motion = t,
    scale = Math.exp(mix(Math.log(a.scale), Math.log(b.scale), t));
  if (dist > 0 && span / dist < Math.max(a.scale, b.scale) * 0.8) {
    const w0 = span / a.scale,
      w1 = span / b.scale,
      k = Math.max(dist, w0, w1),
      x = w0 / k,
      y = w1 / k,
      d = dist / k;
    const r0 = -Math.asinh((y * y - x * x + 4 * d * d) / (4 * x * d)),
      r1 = -Math.asinh((y * y - x * x - 4 * d * d) / (4 * y * d)),
      len = r1 - r0;
    if (Number.isFinite(len) && len > 1e-12) {
      const r = r0 + len * t,
        lc = logCosh(r),
        f = Math.exp(logSinh(len * t) - logSinh(len) + logCosh(r1) - lc);
      motion = f < 0.5 ? f : 1 - Math.exp(logSinh(len * (1 - t)) - logSinh(len) + logCosh(r0) - lc);
      scale = Math.exp(Math.log(a.scale) + lc - logCosh(r0));
    }
  }
  return {
    x: mix(a.x, b.x, clamp(motion, 0, 1)),
    y: mix(a.y, b.y, clamp(motion, 0, 1)),
    scale: clamp(scale, 1e-6, 1e10),
  };
}
export function readNode(view, index, display = false) {
  const p = index * 96;
  return {
    index,
    x: view.getFloat64(p, true),
    y: view.getFloat64(p + 8, true),
    w: view.getFloat64(p + 16, true),
    h: view.getFloat64(p + 24, true),
    id: view.getUint32(p + 32, true),
    parent: view.getUint32(p + 36, true),
    lines: view.getUint32(p + (display ? 64 : 40), true),
    columns: view.getUint32(p + (display ? 68 : 44), true),
    panels: view.getUint32(p + 48, true),
    depth: view.getUint32(p + 52, true),
    kind: view.getUint32(p + 56, true),
    color: view.getUint32(p + 60, true),
    preview: view.getUint32(p + (display ? 72 : 76), true),
    pathOffset: view.getUint32(p + 80, true),
    pathLength: view.getUint32(p + 84, true),
  };
}
