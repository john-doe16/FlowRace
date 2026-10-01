import { MAX_COLORS, neighborTable, type Board, type Cell, type Paths } from '../../shared/board.ts';
import { randInt, shuffle, type Rng } from './rng.ts';
import { solve } from './solver.ts';

export interface Puzzle {
  board: Board;
  solution: Paths;
}

/** Colour-count range per board size, roughly matching hand-made Flow packs. */
export function colorRange(size: number): [number, number] {
  switch (size) {
    case 5: return [4, 6];
    case 6: return [5, 7];
    case 7: return [6, 8];
    case 8: return [7, 10];
    case 9: return [8, 12];
    case 10: return [10, 14];
    default: return [12, 16];
  }
}

/**
 * Covers the grid with paths by starting from single cells and repeatedly
 * joining a path end to a neighbouring path end. A join is only allowed if
 * the merged path never runs alongside itself, which keeps routes readable
 * and makes unique solutions far more likely. Returns null on a dead end.
 */
export interface CoverStats {
  tooMany: number;
  tooShort: number;
  colours: number[];
}

export function randomCover(size: number, rng: Rng, stats?: CoverStats): Paths | null {
  const n = size * size;
  const nb = neighborTable(size);
  const [lo, hi] = colorRange(size);
  const goal = randInt(rng, lo, hi);

  const owner = new Int32Array(n);
  const paths = new Map<number, Cell[]>();
  for (let cell = 0; cell < n; cell++) {
    owner[cell] = cell;
    paths.set(cell, [cell]);
  }

  const touches = (p: Cell[], end: Cell, q: number, start: Cell): boolean => {
    for (const x of p) {
      for (const y of nb[x]) {
        if (owner[y] === q && !(x === end && y === start)) return true;
      }
    }
    return false;
  };

  const tryJoin = (pid: number): boolean => {
    const p = paths.get(pid)!;
    const ends = p.length === 1 ? [p[0]] : shuffle(rng, [p[0], p[p.length - 1]]);
    for (const end of ends) {
      for (const f of shuffle(rng, nb[end].slice())) {
        const qid = owner[f];
        if (qid === pid) continue;
        const q = paths.get(qid)!;
        if (q[0] !== f && q[q.length - 1] !== f) continue;
        if (touches(p, end, qid, f)) continue;
        const left = p[p.length - 1] === end ? p : p.slice().reverse();
        const right = q[0] === f ? q : q.slice().reverse();
        const merged = left.concat(right);
        paths.delete(qid);
        paths.set(pid, merged);
        for (const cell of right) owner[cell] = pid;
        return true;
      }
    }
    return false;
  };

  /**
   * Reshape move for when no join is possible: a path end takes over the tail
   * of a neighbouring path (from the touched cell to one of its ends). The
   * number of paths stays the same, but the layout changes enough to open up
   * new joins. Without this, big boards get stuck with far too many colours.
   */
  const tryReshape = (grower?: number): boolean => {
    const ids = [...paths.keys()];
    const pid = grower ?? ids[Math.floor(rng() * ids.length)];
    const p = paths.get(pid)!;
    const end = p.length === 1 || rng() < 0.5 ? p[p.length - 1] : p[0];
    const f = nb[end][Math.floor(rng() * nb[end].length)];
    const qid = owner[f];
    if (qid === pid) return false;
    const q = paths.get(qid)!;
    const k = q.indexOf(f);
    // Take f and everything on one side of it; the other side stays as q.
    const towardEnd = rng() < 0.5;
    const taken = towardEnd ? q.slice(k) : q.slice(0, k + 1).reverse();
    const kept = towardEnd ? q.slice(0, k) : q.slice(k + 1);
    if (kept.length < 2) return false;
    // The grown path must not run alongside itself.
    const takenSet = new Set(taken);
    for (const x of p) {
      for (const y of nb[x]) {
        if (takenSet.has(y) && !(x === end && y === f)) return false;
      }
    }
    const left = p[p.length - 1] === end ? p : p.slice().reverse();
    paths.set(pid, left.concat(taken));
    paths.set(qid, kept);
    for (const cell of taken) owner[cell] = pid;
    return true;
  };

  let reshapes = 0;
  const maxReshapes = n * 40;
  while (paths.size > goal) {
    // Favour short paths so no single cells get stranded, with some noise.
    const order = [...paths.keys()]
      .map((id) => ({ id, key: paths.get(id)!.length + rng() * 4 }))
      .sort((a, b) => a.key - b.key);
    let joined = false;
    for (const { id } of order) {
      if (tryJoin(id)) {
        joined = true;
        break;
      }
    }
    if (joined) continue;
    // Stuck. Within the colour range that's fine: more colours means shorter
    // pipes and much faster uniqueness checks. Above it, reshape and retry.
    if (paths.size <= hi) break;
    let moved = false;
    while (!moved && reshapes < maxReshapes) {
      reshapes++;
      moved = tryReshape();
    }
    if (!moved) break;
  }

  // Repair: let any pipe shorter than 3 cells grow into a neighbour's tail.
  for (let tries = 0; tries < n * 4; tries++) {
    const short = [...paths.entries()].find(([, p]) => p.length < 3);
    if (!short) break;
    tryReshape(short[0]);
  }

  const result = [...paths.values()];
  stats?.colours.push(result.length);
  if (result.length > hi || result.length > MAX_COLORS) {
    if (stats) stats.tooMany++;
    return null;
  }
  if (result.some((p) => p.length < 3)) {
    if (stats) stats.tooShort++;
    return null;
  }
  return result;
}

export interface GenerateOptions {
  maxAttempts?: number;
  nodeBudget?: number;
  makeId?: () => string;
}

/** Generates a board with exactly one solution, or null if attempts run out. */
export function generatePuzzle(size: number, rng: Rng, opts: GenerateOptions = {}): Puzzle | null {
  const maxAttempts = opts.maxAttempts ?? 500;
  const nodeBudget = opts.nodeBudget ?? 50_000;
  const makeId = opts.makeId ?? (() => Math.floor(rng() * 2 ** 48).toString(36));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cover = randomCover(size, rng);
    if (!cover) continue;
    // Shuffle colour order so colours aren't correlated with position.
    shuffle(rng, cover);
    const dots = cover.map((p): [Cell, Cell] => [p[0], p[p.length - 1]]);
    const result = solve(size, dots, 2, nodeBudget);
    if (result.complete && result.count === 1) {
      return { board: { id: makeId(), size, dots }, solution: cover };
    }
  }
  return null;
}
