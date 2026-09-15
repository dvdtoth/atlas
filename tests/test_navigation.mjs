import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFlightPose } from '../src/render/flight-navigation.mjs';
import { orientFold, pick3D } from '../src/render/visibility.mjs';
import { basis } from '../src/render/core.mjs';
import * as navigation from '../src/render/flight-navigation.mjs';

test('web keyboard flight uses half the previous normal and Shift speed at every cruise scale', () => {
  assert.equal(typeof navigation.keyboardFlightSpeed, 'function');
  for (const speed of [1, 160, 1e6])
    for (const cruise of [0.05, 1, 100]) {
      assert.equal(navigation.keyboardFlightSpeed(speed, cruise, false), speed * cruise * 0.5);
      assert.equal(navigation.keyboardFlightSpeed(speed, cruise, true), speed * cruise * 4 * 0.5);
    }
});

test('3D search centers the requested source row on both sides of every fold', () => {
  const n = { id: 9, index: 0, x: 2e5, y: 3e5, w: 220, h: 600, lines: 401, columns: 90, panels: 1 };
  for (const line of [0, 95, 96, 110, 191, 192, 300, 400]) {
    const pose = sourceFlightPose(n, line, 0, 20),
      fold = orientFold(pose.fold, pose),
      hit = pick3D([fold], pose.eye, basis(pose.yaw, pose.pitch).forward);
    assert.ok(hit, `row ${line} has a forward hit`);
    assert.equal(hit.line, line);
    assert.equal(hit.id, n.id);
  }
});

test('reading distance depends on source rows even with exceptionally wide lines', () => {
  const n = {
    id: 10,
    index: 0,
    x: 0,
    y: 0,
    w: 1000,
    h: 1200,
    lines: 600,
    columns: 4096,
    panels: 1,
  };
  const pose = sourceFlightPose(n, 10, 0, 0, true);
  assert.ok(Math.hypot(...pose.eye.map((v, i) => v - pose.target[i])) / pose.fold.lineHeight < 50);
  const hit = pick3D([orientFold(pose.fold, pose)], pose.eye, basis(pose.yaw, pose.pitch).forward);
  assert.equal(hit.line, 10);
});
