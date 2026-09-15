import { FOV, basis, sub, dot, add, mul, clamp } from './core.mjs';
import { TILE_COLUMNS, TILE_ROWS, CELL_WIDTH, ROW_HEIGHT } from './text-layout.mjs';

export const TEXT_SCALES = [0.25, 0.5, 1, 2, 4];
export function rasterScale(pixels) {
  return pixels <= 5 ? 0.25 : pixels <= 10 ? 0.5 : pixels <= 20 ? 1 : pixels <= 40 ? 2 : 4;
}
export function tileShape(scale) {
  const divisor = Math.max(1, scale / 2);
  const columns = TILE_COLUMNS / divisor,
    rows = TILE_ROWS / divisor;
  return { columns, rows, width: columns * CELL_WIDTH * scale, height: rows * ROW_HEIGHT * scale };
}
export function mapTextOpacity(pixels) {
  const t = clamp((pixels - 0.5) / 1.1, 0, 1);
  return t * t * (3 - 2 * t);
}
export function textOpacity(pixels, minPixels = 0.9) {
  const t = clamp((pixels - minPixels) / 1.8, 0, 1);
  return t * t * (3 - 2 * t);
}
export function tileMipLevels(scale) {
  // Stop when the source row becomes subpixel. All qualities share this cap
  // in texture space, including smaller tiles used for close reading.
  return 1 + Math.floor(Math.log2(ROW_HEIGHT * Math.min(scale, 2)));
}
export function tileTextureBytes(scale) {
  let { width, height } = tileShape(scale),
    total = 0;
  for (let level = 0; level < tileMipLevels(scale); level++) {
    total += width * height * 4;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return total;
}

export function mapRasterScale(pixels, regions, availableBytes, availableDraws) {
  const preferred = rasterScale(pixels);
  for (const scale of [...TEXT_SCALES].reverse()) {
    if (scale > preferred) continue;
    const shape = tileShape(scale);
    // Conservatively count boundary tiles too: full-resolution tiles at the
    // viewport edges still consume their complete texture allocation.
    const count = regions.reduce(
      (sum, r) =>
        sum +
        (Math.ceil(r.end / shape.rows) - Math.floor(r.start / shape.rows)) *
          (Math.ceil(r.col1 / shape.columns) - Math.floor(r.col0 / shape.columns)),
      0,
    );
    if (count <= availableDraws && count * tileTextureBytes(scale) <= availableBytes) return scale;
  }
  return TEXT_SCALES[0];
}
export function cachedTextTile(cache, base, scale, revision) {
  const order = [
    scale,
    ...TEXT_SCALES.filter((s) => s !== scale).sort(
      (a, b) => Math.abs(Math.log2(a / scale)) - Math.abs(Math.log2(b / scale)) || a - b,
    ),
  ];
  for (const s of order) {
    // A high-resolution tile can cover less source than the requested region.
    if (tileShape(s).rows < tileShape(scale).rows) continue;
    const key = base + s,
      tile = cache.get(key);
    if (tile && (revision == null || tile.revision === revision)) return { key, tile };
  }
  return null;
}

export function cachedSourceLine(cache, id, displayRow, revision) {
  if (displayRow === undefined) return undefined;
  for (const tile of cache.values()) {
    if (tile.id !== id || !tile.display || (revision != null && tile.revision !== revision))
      continue;
    const offset = displayRow - tile.start;
    if (offset >= 0 && offset < tile.lineMap.length) return tile.lineMap[offset];
  }
  return undefined;
}

// Per-tile perspective derivatives: a long fold's centre can be distant or
// behind the eye while its visible end is readable. Check the tile itself.
export function flightTileDetail(
  origin,
  across,
  down,
  rows,
  columns,
  cam,
  w,
  h,
  dpr = 1,
  minPixels = 0.9,
) {
  const b = basis(cam.yaw, cam.pitch),
    focal = h / (2 * Math.tan(FOV / 2));
  const view = (p) => [dot(p, b.right), dot(p, b.up), dot(p, b.forward)];
  const o = view(sub(origin, cam.eye)),
    a = view(across),
    d = view(down);
  const points = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
  ].map(([u, v]) => add(add(o, mul(a, u)), mul(d, v)));
  const front = points.filter((p) => p[2] > 1e-8);
  if (!front.length) return null;
  const projected = front.map((p) => ({
    x: w / 2 + (p[0] / p[2]) * focal,
    y: h / 2 - (p[1] / p[2]) * focal,
    p,
  }));
  if (
    front.length === points.length &&
    (Math.max(...projected.map((p) => p.x)) < -20 ||
      Math.min(...projected.map((p) => p.x)) > w + 20 ||
      Math.max(...projected.map((p) => p.y)) < -20 ||
      Math.min(...projected.map((p) => p.y)) > h + 20)
  )
    return null;
  const within = projected.filter(
    (p) => p.x >= -20 && p.x <= w + 20 && p.y >= -20 && p.y <= h + 20,
  );
  const samples = within.length ? within : projected;
  const derivative = (p, v) =>
    (focal * Math.hypot(v[0] * p[2] - p[0] * v[2], v[1] * p[2] - p[1] * v[2])) / (p[2] * p[2]);
  let pixels = 0;
  for (const { p } of samples)
    pixels = Math.max(
      pixels,
      Math.min(
        derivative(p, d) / Math.max(1, rows),
        derivative(p, a) / Math.max(1, columns) / 0.45,
      ) * dpr,
    );
  if (!Number.isFinite(pixels) || pixels <= minPixels) return null;
  // Flight uses fixed 128x32 source regions; the smaller 4x tiles are for 2D.
  return {
    pixels,
    scale: Math.min(2, rasterScale(pixels)),
    opacity: textOpacity(pixels, minPixels),
  };
}
