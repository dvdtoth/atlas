const MiB = 1048576;
const profiles = [
  {
    name: 'light',
    maxDraws: 256,
    workingBytes: 96 * MiB,
    cacheBytes: 160 * MiB,
    maxFiles: 128,
    maxExamined: 4000,
    maxPending: 24,
    minPixels: 1.2,
  },
  {
    name: 'balanced',
    maxDraws: 768,
    workingBytes: 288 * MiB,
    cacheBytes: 384 * MiB,
    maxFiles: 320,
    maxExamined: 9000,
    maxPending: 64,
    minPixels: 0.9,
  },
  {
    name: 'rich',
    maxDraws: 1536,
    workingBytes: 480 * MiB,
    cacheBytes: 640 * MiB,
    maxFiles: 640,
    maxExamined: 16000,
    maxPending: 96,
    minPixels: 0.75,
  },
];

// Memory/concurrency are coarse hints, not measurements of available VRAM.
// A GPU allocation limit only constrains buffer size; it never selects a tier.
export class AdaptiveTextBudget {
  constructor({ deviceMemory, hardwareConcurrency, fallback = false, maxBufferSize } = {}) {
    const memory = Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : null;
    const cores = Number.isFinite(hardwareConcurrency) ? hardwareConcurrency : 0;
    this.maxTier =
      fallback || (memory != null && memory <= 2)
        ? 0
        : memory != null && memory <= 4
          ? 1
          : memory >= 8 || cores >= 8
            ? 2
            : 1;
    this.tier = this.maxTier === 2 && memory >= 8 && cores >= 8 ? 2 : Math.min(1, this.maxTier);
    const capacity =
      Number.isFinite(maxBufferSize) && maxBufferSize > 0 ? Math.floor(maxBufferSize / 256) : 1536;
    this.profiles = profiles.map((p) =>
      Object.freeze({ ...p, maxDraws: Math.max(1, Math.min(p.maxDraws, capacity)) }),
    );
    this.capacity = this.profiles[this.maxTier].maxDraws;
    this.good = 0;
    this.bad = 0;
    this.lastSample = -Infinity;
    this.changedAt = -Infinity;
  }
  get current() {
    return this.profiles[this.tier];
  }
  observe({ now, cpuMs, queueMs, visible = true }) {
    if (!visible || ![now, cpuMs, queueMs].every(Number.isFinite) || cpuMs < 0 || queueMs < 0) {
      this.good = this.bad = 0;
      this.lastSample = -Infinity;
      return false;
    }
    if (now <= this.lastSample) return false;
    if (now - this.lastSample > 2500) this.good = this.bad = 0;
    this.lastSample = now;
    if (now - this.changedAt < 8000) return false;
    const slow = cpuMs > 6 || queueMs > 12,
      fast = cpuMs < 2.5 && queueMs < 6;
    this.bad = slow ? this.bad + 1 : 0;
    this.good = fast ? this.good + 1 : 0;
    let next = this.tier;
    if (this.bad >= 3) next = Math.max(0, next - 1);
    else if (this.good >= 6) next = Math.min(this.maxTier, next + 1);
    if (next === this.tier) return false;
    this.tier = next;
    this.changedAt = now;
    this.good = this.bad = 0;
    return true;
  }
}
