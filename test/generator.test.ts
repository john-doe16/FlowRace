import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cell } from '../shared/board.ts';
import { checkSolution } from '../shared/validate.ts';
import { colorRange, generatePuzzle, randomCover } from '../server/core/generator.ts';
import { PuzzlePool } from '../server/core/puzzle-pool.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { solve } from '../server/core/solver.ts';
import { bruteForceCount } from './helpers.ts';

test('solver finds both solutions of an open 3x3 corner-to-corner board', () => {
  const result = solve(3, [[0, 8]]);
  assert.equal(result.count, 2);
  assert.equal(result.complete, true);
});

test('solver reports no solution for an impossible board', () => {
  // Two colours that must cross on a 3x3.
  const result = solve(3, [[1, 7], [3, 5]]);
  assert.equal(result.count, 0);
  assert.equal(result.complete, true);
});

test('solver agrees with brute force on random 5x5 dot layouts', () => {
  const rng = mulberry32(7);
  let checked = 0;
  const counts = [0, 0, 0];
  for (let i = 0; checked < 120 && i < 5000; i++) {
    // Random covers give solvable layouts; shuffling endpoints between
    // colours gives unsolvable or multi-solution ones too.
    const cover = randomCover(5, rng);
    if (!cover) continue;
    const ends = cover.flatMap((p) => [p[0], p[p.length - 1]]);
    if (i % 3 === 0) ends.sort(() => rng() - 0.5);
    const dots: [Cell, Cell][] = [];
    for (let j = 0; j < ends.length; j += 2) dots.push([ends[j], ends[j + 1]]);
    const fast = solve(5, dots, 2, 5_000_000);
    assert.equal(fast.complete, true);
    assert.equal(fast.count, bruteForceCount(5, dots, 2), `layout ${JSON.stringify(dots)}`);
    counts[fast.count]++;
    checked++;
  }
  assert.equal(checked, 120);
  // Make sure all three outcomes were actually exercised.
  assert.ok(counts.every((c) => c > 0), `outcomes ${counts}`);
});

for (const size of [5, 6, 7, 8, 9, 10, 11]) {
  test(`generates valid unique ${size}x${size} boards`, () => {
    const rng = mulberry32(size * 101);
    for (let i = 0; i < 5; i++) {
      const puzzle = generatePuzzle(size, rng);
      assert.ok(puzzle, 'generator gave up');
      const { board, solution } = puzzle;
      assert.equal(board.size, size);
      const [lo, hi] = colorRange(size);
      assert.ok(board.dots.length >= lo && board.dots.length <= hi);
      assert.deepEqual(checkSolution(board, solution), { ok: true });
      const again = solve(size, board.dots, 2, 5_000_000);
      assert.equal(again.complete, true);
      assert.equal(again.count, 1);
    }
  });
}

test('pool asks for the emptiest size and takes boards made elsewhere', () => {
  const pool = new PuzzlePool(mulberry32(1), () => 2);
  pool.refill(60_000);
  assert.equal(pool.wanted(), null, 'every size stocked');
  const board = pool.next(11);
  assert.equal(board.size, 11);
  assert.equal(pool.wanted(), 11);
  pool.add(board);
  assert.equal(pool.wanted(), null);
});

test('brute force confirms generated 5x5 and 6x6 boards are unique', () => {
  const rng = mulberry32(99);
  for (const size of [5, 6]) {
    for (let i = 0; i < 10; i++) {
      const puzzle = generatePuzzle(size, rng)!;
      assert.equal(bruteForceCount(size, puzzle.board.dots, 2), 1);
    }
  }
});
