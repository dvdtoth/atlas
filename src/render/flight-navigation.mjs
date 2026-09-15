import { foldAt, clamp, add, mul, norm, cross, length, look } from './core.mjs';
import { orientFold } from './visibility.mjs';

export function keyboardFlightSpeed(speed, cruise = 1, boost = false) {
  return speed * cruise * (boost ? 4 : 1) * 0.5;
}

// Aim in the same camera-facing source frame used by picking and text tiles.
// Odd folds reverse their physical row direction when viewed from above.
export function sourceFlightPose(n, line, column, elevation = 0, reading = true) {
  line = clamp(line, 0, Math.max(0, n.lines - 1));
  const fold = foldAt(n, line, elevation),
    normal = norm(cross([fold.w, 0, 0], [0, fold.dy, fold.dz]));
  if (normal[1] < 0) for (let i = 0; i < 3; i++) normal[i] *= -1;
  const distance = reading
    ? fold.lineHeight * 36
    : Math.max(fold.w * 1.2, length([fold.w, fold.dy, fold.dz]));
  const offset = add(mul(normal, distance), [0, distance * 0.15, distance * 0.18]);
  const direction = look(offset, [0, 0, 0]),
    oriented = orientFold(fold, direction);
  const u = clamp(
      Math.min(column + 20, Math.max(1, n.columns) * 0.5) / Math.max(1, n.columns),
      0,
      0.999,
    ),
    v = (line - fold.start + 0.5) / fold.count;
  const target = add(add(oriented.origin, mul(oriented.across, u)), mul(oriented.down, v));
  const eye = add(target, offset);
  return {
    eye,
    ...direction,
    target,
    fold,
    speed: Math.max(fold.lineHeight * 160, distance * 0.4),
  };
}
