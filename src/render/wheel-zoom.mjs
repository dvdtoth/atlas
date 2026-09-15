import { clamp } from './core.mjs';

// CSS pixels: about 27px glyphs at the closest reading distance.
export function readingZoomLimit(lineHeight, minimum) {
  return Math.max(minimum, 36 / Math.max(1e-20, lineHeight));
}

export function wheelDelta(delta, mode, viewportHeight) {
  return delta * (mode === 1 ? 16 : mode === 2 ? viewportHeight : 1);
}

/** A short, cursor-anchored tween. Input accumulates against the target, not
 * the partially animated camera, so high-refresh trackpads lose no distance. */
export class WheelZoom {
  active = false;
  cancel() {
    this.active = false;
  }
  push(camera, pointer, delta, ctrl, minimum, maximum, now, reducedMotion = false) {
    const base = this.active ? this.target : camera.scale;
    // Input can arrive several times between RAFs. Preserve that elapsed motion
    // before retargeting, even if the previous frame has not drawn it yet.
    camera = this.sample(now) || camera;
    this.target = clamp(
      base * Math.exp(clamp(-delta * (ctrl ? 0.009 : 0.0025), -0.65, 0.65)),
      minimum,
      Math.max(camera.scale, maximum),
    );
    this.from = { ...camera };
    this.pointer = { ...pointer };
    this.started = now;
    this.duration = reducedMotion ? 0 : 160;
    this.active = true;
  }
  sample(now) {
    if (!this.active) return null;
    const t = this.duration ? clamp((now - this.started) / this.duration, 0, 1) : 1;
    if (t === 0) return { ...this.from };
    const f = 1 - (1 - t) ** 3;
    const scale = Math.exp(Math.log(this.from.scale) * (1 - f) + Math.log(this.target) * f);
    if (t === 1) this.active = false;
    return {
      x: this.from.x + this.pointer.x * (1 / this.from.scale - 1 / scale),
      y: this.from.y + this.pointer.y * (1 / this.from.scale - 1 / scale),
      scale,
    };
  }
}
