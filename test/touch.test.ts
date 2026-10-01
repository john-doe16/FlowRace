import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stickyCellAt } from '../client/render.ts';

// A 5x5 board drawn at 500x500 CSS px: each cell is 100px.
const rect = { left: 0, top: 0, width: 500, height: 500 };
const at = (x: number, y: number, last: number) => stickyCellAt(rect, 5, x, y, last);

test('stays on the current cell until the pointer is well past the border', () => {
  // Cell 0 is (0,0). Crossing x=100 into cell 1 needs 20px (0.2 cells).
  assert.equal(at(110, 50, 0), 0);
  assert.equal(at(125, 50, 0), 1);
  // And back again: from cell 1, x=95 is still too close to the border.
  assert.equal(at(95, 50, 1), 1);
  assert.equal(at(75, 50, 1), 0);
});

test('a finger running along a grid line does not flicker between rows', () => {
  let cell = 0;
  for (const y of [98, 102, 97, 103, 99]) {
    cell = at(50, y, cell);
    assert.equal(cell, 0);
  }
});

test('jumps of more than one cell are taken immediately', () => {
  assert.equal(at(305, 50, 0), 3);
});

test('positions outside the board clamp to the edge', () => {
  assert.equal(at(-40, 50, 0), 0);
  assert.equal(at(560, 450, 24), 24);
  assert.equal(at(560, 450, 23), 24);
});
