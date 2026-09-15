import test from 'node:test';
import assert from 'node:assert/strict';
const zoom = await import('../src/render/wheel-zoom.mjs').catch(() => ({}));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const camera = { x: 40, y: 70, scale: 2 };
const pointer = { x: 160, y: -90 };

test('wheel zoom eases between frames and keeps the source beneath the cursor stationary', () => {
  const wheel = new zoom.WheelZoom();
  wheel.push(camera, pointer, -100, 0, 0.01, 100, 0);
  assert.deepEqual(wheel.sample(0), camera);
  const mid = wheel.sample(60),
    end = wheel.sample(200);
  assert.ok(mid.scale > camera.scale && mid.scale < end.scale);
  for (const c of [mid, end]) {
    near(c.x + pointer.x / c.scale, camera.x + pointer.x / camera.scale);
    near(c.y + pointer.y / c.scale, camera.y + pointer.y / camera.scale);
  }
  assert.equal(wheel.active, false);
});

test('wheel targets accumulate, retarget without a jump, and settle independent of frame rate', () => {
  const wheel = new zoom.WheelZoom();
  wheel.push(camera, pointer, -100, 0, 0.01, 100, 0);
  const mid = wheel.sample(40);
  wheel.push(mid, pointer, -100, 0, 0.01, 100, 40);
  assert.deepEqual(wheel.sample(40), mid);
  near(wheel.sample(240).scale, 2 * Math.exp(0.5));
  const a = new zoom.WheelZoom(),
    b = new zoom.WheelZoom();
  for (const wheel of [a, b]) wheel.push(camera, pointer, -100, 0, 0.01, 100, 0);
  a.sample(16);
  a.sample(32);
  b.sample(33);
  assert.deepEqual(a.sample(80), b.sample(80));
});

test('zoom respects reading limits, has no accumulated overshoot, and can be canceled', () => {
  const wheel = new zoom.WheelZoom();
  for (let i = 0; i < 20; i++) wheel.push(camera, pointer, -100, 0, 0.01, 2.2, i);
  const end = wheel.sample(220);
  near(end.scale, 2.2);
  wheel.push(end, pointer, 100, 0, 0.01, 2.2, 221);
  assert.ok(wheel.sample(250).scale < end.scale);
  wheel.cancel();
  assert.equal(wheel.active, false);
  assert.equal(wheel.sample(500), null);
  near(zoom.readingZoomLimit(0.5, 0.01), 72);
});

test('line/page wheel units are normalized and reduced motion applies the target immediately', () => {
  near(zoom.wheelDelta(3, 1, 600), 48);
  near(zoom.wheelDelta(1, 2, 600), 600);
  const wheel = new zoom.WheelZoom();
  wheel.push(camera, pointer, -100, 0, 0.01, 100, 0, true);
  near(wheel.sample(0).scale, 2 * Math.exp(0.25));
  assert.equal(wheel.active, false);
});

test('continuous wheel input cannot starve animation between display frames', () => {
  function gesture(phase) {
    const wheel = new zoom.WheelZoom();
    let cam = { x: 0, y: 0, scale: 1 },
      event = phase;
    for (let frame = 0; frame <= 1000; frame += 1000 / 60) {
      while (event <= frame) {
        wheel.push(cam, pointer, -5, 0, 0.01, 100, event);
        event += 1000 / 120;
      }
      cam = wheel.sample(frame) || cam;
    }
    return cam.scale;
  }
  const early = gesture(0),
    late = gesture(8);
  assert.ok(early > 3.5 && late > 3.5);
  assert.ok(Math.abs(early / late - 1) < 0.05);
});
