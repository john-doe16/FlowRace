import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOptions } from '../shared/rules.ts';
import { boardPoint, cellFromPoint, spinAngle } from '../client/render.ts';

const rect = { left: 0, top: 0, width: 500, height: 500 };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('mirror flips input left to right', () => {
  // A click in the top-left cell of a 5x5 lands in the top-right cell.
  const p = boardPoint(rect, 5, 50, 50, { mirror: true });
  assert.equal(cellFromPoint(5, p), 4);
});

test('spin input follows the rotated board', () => {
  // Board turned 90° clockwise: what's drawn at the top-right corner is the board's top-left cell.
  const p = boardPoint(rect, 5, 450, 50, { angle: Math.PI / 2 });
  assert.equal(cellFromPoint(5, p), 0);
  // Unrotated, it's just the top-right cell.
  assert.equal(cellFromPoint(5, boardPoint(rect, 5, 450, 50)), 4);
});

test('points off the board map to no cell', () => {
  assert.equal(cellFromPoint(5, boardPoint(rect, 5, -10, 50)), null);
});

test('spin turns a quarter every interval, easing between', () => {
  assert.equal(spinAngle(7_999, 8000), 0);
  assert.ok(spinAngle(8_100, 8000) > 0 && spinAngle(8_100, 8000) < Math.PI / 2);
  assert.ok(near(spinAngle(9_000, 8000), Math.PI / 2));
  assert.ok(near(spinAngle(17_000, 8000), Math.PI));
});

test('options parsing defaults old saves and rejects junk', () => {
  assert.deepEqual(parseOptions({ sizeMode: 7, durationSec: 120 }), {
    mode: 'race',
    sizeMode: 7,
    durationSec: 120,
    twists: [],
  });
  assert.deepEqual(parseOptions({ mode: 'knockout', sizeMode: 5, durationSec: 60, twists: ['spin', 'fog', 'spin'] })?.twists, [
    'fog',
    'spin',
  ]);
  assert.equal(parseOptions({ mode: 'battle', sizeMode: 5, durationSec: 60 }), null);
  assert.equal(parseOptions({ sizeMode: 5, durationSec: 60, twists: ['lava'] }), null);
});
