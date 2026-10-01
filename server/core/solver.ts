import { neighborTable, type Cell, type Paths } from '../../shared/board.ts';

export interface SolveResult {
  /** Solutions found, capped at the requested limit. */
  count: number;
  /** False if the node budget ran out before the search finished. */
  complete: boolean;
  /** The first solution found, if any. */
  solution: Paths | null;
  nodes: number;
}

/**
 * Depth-first Flow solver used to check that generated boards have exactly
 * one solution. Each colour grows from its first dot towards its second;
 * the colour with the fewest legal moves is extended next, and every state
 * is pruned with dead-end, connectivity and stranded-region checks.
 */
export function solve(size: number, dots: [Cell, Cell][], limit = 2, nodeBudget = 200_000): SolveResult {
  const n = size * size;
  const nb = neighborTable(size);
  const k = dots.length;

  const grid = new Int8Array(n).fill(-1);
  const headOf = new Int8Array(n).fill(-1);
  const targetOf = new Int8Array(n).fill(-1);
  const head: Cell[] = [];
  const target: Cell[] = [];
  const done = new Uint8Array(k);
  const paths: Cell[][] = [];

  for (let c = 0; c < k; c++) {
    const [a, b] = dots[c];
    grid[a] = c;
    grid[b] = c;
    headOf[a] = c;
    targetOf[b] = c;
    head.push(a);
    target.push(b);
    paths.push([a]);
  }

  let empty = n - 2 * k;
  let remaining = k;
  let nodes = 0;
  let count = 0;
  let complete = true;
  let solution: Paths | null = null;

  // Scratch buffers reused by feasible().
  const comp = new Int16Array(n);
  const stack = new Int16Array(n);
  const stamp = new Int32Array(n + 1);
  const claimed = new Uint8Array(n + 1);
  let stampId = 0;

  /** True if the cell can still take part in a path through an empty cell. */
  const isOpen = (y: Cell): boolean => {
    if (grid[y] === -1) return true;
    const h = headOf[y];
    if (h >= 0 && !done[h]) return true;
    const t = targetOf[y];
    return t >= 0 && !done[t];
  };

  function feasible(): boolean {
    // Every empty cell needs at least two neighbours a path could use.
    comp.fill(-1);
    let comps = 0;
    for (let x = 0; x < n; x++) {
      if (grid[x] !== -1) continue;
      let deg = 0;
      for (const y of nb[x]) if (isOpen(y)) deg++;
      if (deg < 2) return false;
      if (comp[x] !== -1) continue;
      // Label this empty region.
      let sp = 0;
      stack[sp++] = x;
      comp[x] = comps;
      while (sp > 0) {
        const cur = stack[--sp];
        for (const y of nb[cur]) {
          if (grid[y] === -1 && comp[y] === -1) {
            comp[y] = comps;
            stack[sp++] = y;
          }
        }
      }
      claimed[comps] = 0;
      comps++;
    }

    // Each unfinished colour must be able to reach its target, and every
    // empty region must be fillable by some colour that borders it at both ends.
    for (let c = 0; c < k; c++) {
      if (done[c]) continue;
      const h = head[c];
      const t = target[c];
      let direct = false;
      stampId++;
      for (const y of nb[h]) {
        if (y === t) direct = true;
        else if (grid[y] === -1) stamp[comp[y]] = stampId;
      }
      let shared = false;
      for (const y of nb[t]) {
        if (grid[y] === -1 && stamp[comp[y]] === stampId) {
          claimed[comp[y]] = 1;
          shared = true;
        }
      }
      if (!shared && !direct) return false;
    }
    for (let i = 0; i < comps; i++) if (!claimed[i]) return false;
    return true;
  }

  function movesOf(c: number, out: Cell[]): number {
    out.length = 0;
    const t = target[c];
    for (const y of nb[head[c]]) {
      if (grid[y] === -1 || y === t) out.push(y);
    }
    return out.length;
  }

  const scratch: Cell[] = [];

  function search(): void {
    if (++nodes > nodeBudget) {
      complete = false;
      return;
    }
    if (remaining === 0) {
      if (empty === 0) {
        count++;
        if (!solution) solution = paths.map((p) => p.slice());
      }
      return;
    }

    // Extend the most constrained colour.
    let best = -1;
    let bestMoves = 5;
    for (let c = 0; c < k; c++) {
      if (done[c]) continue;
      const m = movesOf(c, scratch);
      if (m === 0) return;
      if (m < bestMoves) {
        best = c;
        bestMoves = m;
        if (m === 1) break;
      }
    }

    const moves: Cell[] = [];
    movesOf(best, moves);
    const from = head[best];
    for (const y of moves) {
      // Apply.
      headOf[from] = -1;
      paths[best].push(y);
      const finishing = y === target[best];
      if (finishing) {
        done[best] = 1;
        remaining--;
      } else {
        grid[y] = best;
        headOf[y] = best;
        head[best] = y;
        empty--;
      }

      if (feasible()) search();

      // Undo.
      paths[best].pop();
      if (finishing) {
        done[best] = 0;
        remaining++;
      } else {
        grid[y] = -1;
        headOf[y] = -1;
        head[best] = from;
        empty++;
      }
      headOf[from] = best;

      if (count >= limit || !complete) return;
    }
  }

  if (feasible()) search();
  return { count, complete, solution, nodes };
}
