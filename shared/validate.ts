import { isAdjacent, type Board, type Paths } from './board.ts';

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Checks a full solution: every colour connects its two dots with an
 * orthogonal path, no cell is used twice, and every cell is filled.
 * Any valid solution is accepted, not just the generator's.
 */
export function checkSolution(board: Board, paths: Paths): CheckResult {
  const { size, dots } = board;
  const n = size * size;
  if (!Array.isArray(paths) || paths.length !== dots.length) {
    return { ok: false, reason: 'wrong number of paths' };
  }

  const used = new Uint8Array(n);
  let filled = 0;
  for (let color = 0; color < dots.length; color++) {
    const path = paths[color];
    const [a, b] = dots[color];
    if (!Array.isArray(path) || path.length < 2) {
      return { ok: false, reason: `colour ${color} is not connected` };
    }
    const first = path[0];
    const last = path[path.length - 1];
    if (!((first === a && last === b) || (first === b && last === a))) {
      return { ok: false, reason: `colour ${color} does not join its dots` };
    }
    for (let i = 0; i < path.length; i++) {
      const cell = path[i];
      if (!Number.isInteger(cell) || cell < 0 || cell >= n) {
        return { ok: false, reason: 'cell out of range' };
      }
      if (used[cell]) return { ok: false, reason: 'paths overlap' };
      used[cell] = 1;
      filled++;
      if (i > 0 && !isAdjacent(size, path[i - 1], cell)) {
        return { ok: false, reason: `colour ${color} jumps between cells` };
      }
    }
  }

  if (filled !== n) return { ok: false, reason: 'board is not full' };
  return { ok: true };
}
