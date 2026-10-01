import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board } from '../shared/board.ts';
import { checkSolution } from '../shared/validate.ts';
import { PlayState } from '../client/play-state.ts';
import { testPuzzles } from './helpers.ts';

// 3x3:   0 1 2      dots: red 0-2, blue 3-8
//        3 4 5
//        6 7 8
const board: Board = { id: 't', size: 3, dots: [[0, 2], [3, 8]] };

test('drawing a pipe dot to dot connects it', () => {
  const s = new PlayState(board);
  assert.ok(s.begin(0));
  s.drag(1);
  s.drag(2);
  s.end();
  assert.deepEqual(s.paths[0], [0, 1, 2]);
  assert.ok(s.isComplete(0));
  assert.equal(s.filledCount(), 3);
});

test('fast swipes fill the skipped cells', () => {
  const s = new PlayState(board);
  s.begin(3);
  s.drag(5); // jumps over 4
  assert.deepEqual(s.paths[1], [3, 4, 5]);
});

test('other colours\' dots block, connected pipes stop growing', () => {
  const s = new PlayState(board);
  s.begin(0);
  s.drag(3); // blue dot
  assert.deepEqual(s.paths[0], [0]);
  s.drag(1);
  s.drag(2);
  s.drag(5);
  assert.deepEqual(s.paths[0], [0, 1, 2]);
});

test('dragging back over your own pipe pulls it back', () => {
  const s = new PlayState(board);
  s.begin(3);
  s.drag(4);
  s.drag(5);
  s.drag(4);
  assert.deepEqual(s.paths[1], [3, 4]);
});

test('crossing another pipe cuts it at that point', () => {
  const s = new PlayState(board);
  s.begin(3);
  s.drag(4);
  s.drag(1);
  s.end();
  s.begin(0);
  s.drag(1);
  assert.deepEqual(s.paths[0], [0, 1]);
  assert.deepEqual(s.paths[1], [3, 4]);
});

test('pressing a pipe picks it up from there; pressing a dot restarts it', () => {
  const s = new PlayState(board);
  s.begin(3);
  s.drag(6);
  s.drag(7);
  s.drag(8);
  s.end();
  s.begin(6);
  assert.deepEqual(s.paths[1], [3, 6]);
  s.end();
  s.begin(8);
  assert.deepEqual(s.paths[1], [8]);
});

test('undo steps back one stroke at a time, including clears and cuts', () => {
  const s = new PlayState(board);
  s.begin(0);
  s.drag(1);
  s.drag(2);
  s.end();
  s.begin(3);
  s.drag(4);
  s.drag(1); // cuts red
  s.end();
  assert.deepEqual(s.paths[0], [0]);
  s.clear();
  assert.ok(s.undo()); // undo the clear
  assert.deepEqual(s.paths[1], [3, 4, 1]);
  assert.ok(s.undo()); // undo the cutting stroke: red is whole again
  assert.deepEqual(s.paths[0], [0, 1, 2]);
  assert.deepEqual(s.paths[1], []);
  assert.ok(s.undo());
  assert.deepEqual(s.paths[0], []);
  assert.equal(s.undo(), false);
  assert.equal(s.canUndo, false);
});

test('replaying a generated solution solves the board', () => {
  const puzzles = testPuzzles(5);
  for (const size of [5, 7, 9]) {
    const b = puzzles.next(size);
    const s = new PlayState(b);
    for (const path of puzzles.solutionOf(b)) {
      s.begin(path[0]);
      for (const cell of path.slice(1)) s.drag(cell);
      s.end();
    }
    assert.ok(s.isSolved());
    assert.deepEqual(checkSolution(b, s.solution()), { ok: true });
  }
});
