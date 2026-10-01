import { neighborTable, type Board, type Cell, type Paths } from '../shared/board.ts';
import { generatePuzzle } from '../server/core/generator.ts';
import type { PuzzleSource } from '../server/core/ports.ts';
import { mulberry32 } from '../server/core/rng.ts';

/** Seeded puzzle source that remembers solutions so tests can submit them. */
export function testPuzzles(seed = 1): PuzzleSource & { solutionOf(board: Board): Paths } {
  const rng = mulberry32(seed);
  const solutions = new Map<string, Paths>();
  let id = 0;
  return {
    next(size) {
      const puzzle = generatePuzzle(size, rng, { makeId: () => `b${id++}` })!;
      solutions.set(puzzle.board.id, puzzle.solution);
      return puzzle.board;
    },
    solutionOf(board) {
      return solutions.get(board.id)!;
    },
  };
}

/**
 * Pruning-free reference solver: routes each colour in turn through every
 * simple path, then checks the board is full. Exponential, so only for
 * small boards, but trivially correct, which is what makes it useful for
 * cross-checking the real solver.
 */
export function bruteForceCount(size: number, dots: [Cell, Cell][], limit = 2): number {
  const n = size * size;
  const nb = neighborTable(size);
  const used = new Uint8Array(n);
  for (const [a, b] of dots) {
    used[a] = 1;
    used[b] = 1;
  }
  let filled = dots.length * 2;
  let count = 0;

  function route(color: number, at: Cell): void {
    if (count >= limit) return;
    const goal = dots[color][1];
    for (const y of nb[at]) {
      if (y === goal) {
        if (color + 1 === dots.length) {
          if (filled === n) count++;
        } else {
          route(color + 1, dots[color + 1][0]);
        }
      } else if (!used[y]) {
        used[y] = 1;
        filled++;
        route(color, y);
        used[y] = 0;
        filled--;
      }
      if (count >= limit) return;
    }
  }

  route(0, dots[0][0]);
  return count;
}
