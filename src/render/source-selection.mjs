import { surface, add, mul, clamp } from './core.mjs';

// At most three rectangles per source panel/fold: first partial row, full
// middle rows and final partial row. No per-line traversal or source reads.
function spans(range, start, count, columns) {
  const { start: a, end: b } = range,
    spans = [];
  const push = (line, end, x, width) => {
    line = Math.max(line, start);
    end = Math.min(end, start + count);
    x = clamp(x, 0, columns);
    width = clamp(width, 0, columns - x);
    if (end > line && width > 0) spans.push({ line, rows: end - line, x, width });
  };
  if (a.line === b.line) push(a.line, a.line + 1, a.column, b.column - a.column);
  else {
    push(a.line, a.line + 1, a.column, columns - a.column);
    push(a.line + 1, b.line, 0, columns);
    if (b.column > 0) push(b.line, b.line + 1, 0, b.column);
  }
  return spans;
}
export function selectionPlanes2D(n, range) {
  if (!range || !n.lines) return [];
  const s = surface(n),
    planes = [],
    h = s.lineHeight;
  for (let p = 0; p < s.panels; p++) {
    const b = s.panel(p);
    for (const r of spans(range, b.start, b.count, n.columns))
      planes.push({
        origin: [b.x + r.x * 0.45 * h, b.y + (r.line - b.start) * h, 0],
        across: [r.width * 0.45 * h, 0, 0],
        down: [0, r.rows * h, 0],
      });
  }
  return planes;
}
export function selectionPlanes3D(n, range, folds) {
  if (!range) return [];
  const planes = [];
  for (const f of folds) {
    if (f.id !== n.id) continue;
    for (const r of spans(range, f.start, f.count, n.columns)) {
      planes.push({
        origin: add(
          add(f.origin, mul(f.across, r.x / n.columns)),
          mul(f.down, (r.line - f.start) / f.count),
        ),
        across: mul(f.across, r.width / n.columns),
        down: mul(f.down, r.rows / f.count),
      });
    }
  }
  return planes;
}
