import test from 'node:test';
import assert from 'node:assert/strict';
import { FOV } from '../src/render/core.mjs';
const detail = await import('../src/render/text-detail.mjs').catch(() => ({}));

test('distant source uses sixteen times less raster memory while close source retains full detail', () => {
  assert.equal(typeof detail.rasterScale, 'function');
  assert.equal(detail.rasterScale(3), 0.25);
  assert.equal(detail.rasterScale(9), 0.5);
  assert.equal(detail.rasterScale(20), 1);
  assert.equal(detail.rasterScale(35), 2);
  assert.ok(detail.tileTextureBytes(0.25) <= detail.tileTextureBytes(1) / 16);
  assert.ok(detail.textOpacity(2) > 0.6);
  assert.equal(detail.textOpacity(0.5), 0);
});

test('retina text detail uses physical pixels and rejects edge-on or offscreen tiles', () => {
  assert.equal(typeof detail.flightTileDetail, 'function');
  const cam = { eye: [0, 0, 0], yaw: 0, pitch: 0 };
  const args = [[-14.4, 16, -100], [28.8, 0, 0], [0, -32, 0], 32, 64, cam, 800, 600];
  const normal = detail.flightTileDetail(...args, 1),
    retina = detail.flightTileDetail(...args, 2);
  assert.ok(Math.abs(normal.pixels - 600 / (2 * Math.tan(FOV / 2)) / 100) < 1e-6);
  assert.equal(normal.scale, 0.25);
  assert.equal(retina.scale, 0.5);
  assert.equal(
    detail.flightTileDetail([10000, 16, -100], [28.8, 0, 0], [0, -32, 0], 32, 64, cam, 800, 600, 1),
    null,
  );
  assert.equal(
    detail.flightTileDetail([0, 16, -100], [0, 0, -28.8], [0, -32, 0], 32, 64, cam, 800, 600, 1),
    null,
  );
});

test('a tile crossing the camera plane can retain readable text at its visible edge', () => {
  assert.equal(typeof detail.flightTileDetail, 'function');
  const tile = detail.flightTileDetail(
    [-2, 2, 1],
    [4, 0, 0],
    [0, -4, -20],
    32,
    64,
    { eye: [0, 0, 0], yaw: 0, pitch: 0 },
    800,
    600,
    2,
  );
  assert.ok(tile && Number.isFinite(tile.pixels) && tile.opacity > 0);
});

test('a cached lower-resolution tile stays available during refinement without crossing revisions', () => {
  assert.equal(typeof detail.cachedTextTile, 'function');
  const base = '7:3d:64:0:',
    low = { revision: 'a', quality: '.25' },
    other = { revision: 'b' };
  const cache = new Map([
    [base + '.25', low],
    [base + '2', other],
  ]);
  // Keys use ordinary number formatting, as the request protocol does.
  cache.set(base + '0.25', low);
  cache.delete(base + '.25');
  assert.equal(detail.cachedTextTile(cache, base, 1, 'a')?.tile, low);
  assert.equal(detail.cachedTextTile(cache, base, 1, 'missing'), null);
  const exact = { revision: 'a' };
  cache.set(base + '1', exact);
  assert.equal(detail.cachedTextTile(cache, base, 1, 'a')?.tile, exact);
});

test('close reading increases raster quality without increasing the maximum tile allocation', () => {
  assert.equal(detail.rasterScale(72), 4);
  assert.equal(detail.rasterScale(100000), 4);
  assert.deepEqual(detail.tileShape(4), { columns: 64, rows: 16, width: 2304, height: 1280 });
  assert.equal(detail.tileTextureBytes(4), detail.tileTextureBytes(2));
});

test('a smaller high-resolution tile cannot substitute for a larger source region', () => {
  const base = '7:2d:0:0:',
    cache = new Map([[base + '4', { revision: 'a' }]]);
  assert.equal(detail.cachedTextTile(cache, base, 1, 'a'), null);
});

test('syntax minimaps remain visible below the old text cutoff and blend with resident bars', () => {
  assert.ok(detail.mapTextOpacity(1.6) > 0.9);
  assert.ok(detail.mapTextOpacity(0.8) > 0);
  assert.equal(detail.mapTextOpacity(0.3), 0);
});

test('hover source mapping finds a containing close-reading tile, including the second half of a page', () => {
  const cache = new Map([
    [
      'first',
      {
        id: 7,
        display: true,
        start: 0,
        revision: 'a',
        lineMap: Array.from({ length: 16 }, (_, i) => 100 + i),
      },
    ],
    ['flight', { id: 7, display: false, start: 16, revision: 'a', lineMap: [0, 1] }],
    ['old', { id: 7, display: true, start: 16, revision: 'old', lineMap: [3, 4] }],
    ['second', { id: 7, display: true, start: 16, revision: 'a', lineMap: [115, 115, 116] }],
  ]);
  assert.equal(detail.cachedSourceLine(cache, 7, 17, 'a'), 115);
  assert.equal(detail.cachedSourceLine(cache, 7, 18, 'a'), 116);
  assert.equal(detail.cachedSourceLine(cache, 7, 19, 'a'), undefined);
  assert.equal(detail.cachedSourceLine(cache, 8, 17, 'a'), undefined);
});

test('Retina close reading lowers raster quality before excluding visible source tiles', () => {
  const regions = [{ start: 478, end: 523, col0: 57, col1: 210 }];
  const quality = detail.mapRasterScale(42, regions, 144 * 1048576, 384);
  assert.equal(quality, 2);
  assert.ok(detail.mapRasterScale(72, regions, 96 * 1048576, 256) <= 2);
  assert.equal(
    detail.mapRasterScale(72, [{ start: 0, end: 16, col0: 0, col1: 64 }], 96 * 1048576, 256),
    4,
  );
});
