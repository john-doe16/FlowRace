import { MAX_SIZE, MIN_SIZE, type Board } from '../../shared/board.ts';
import { generatePuzzle } from './generator.ts';
import type { PuzzleSource } from './ports.ts';
import type { Rng } from './rng.ts';

/** Big boards are slower to make and less often played, so keep fewer in stock. */
export function defaultStock(size: number): number {
  return size >= 10 ? 20 : 40;
}

/**
 * Keeps a stock of ready boards per size so matches never wait on the
 * generator. The host keeps it topped up, ideally from a worker thread
 * (`wanted()` + `add()`), or in small slices on the main thread (`refill()`).
 * If a size runs dry, next() generates synchronously as a last resort.
 */
export class PuzzlePool implements PuzzleSource {
  private readonly pools = new Map<number, Board[]>();
  private readonly rng: Rng;
  private readonly stockFor: (size: number) => number;

  constructor(rng: Rng, stockFor: (size: number) => number = defaultStock) {
    this.rng = rng;
    this.stockFor = stockFor;
    for (let size = MIN_SIZE; size <= MAX_SIZE; size++) this.pools.set(size, []);
  }

  next(size: number): Board {
    return this.pools.get(size)?.pop() ?? this.generate(size);
  }

  stock(size: number): number {
    return this.pools.get(size)?.length ?? 0;
  }

  /** The size most in need of boards, or null when every pool is full. */
  wanted(): number | null {
    let best: number | null = null;
    let lowest = 1;
    for (const [size, pool] of this.pools) {
      const fill = pool.length / this.stockFor(size);
      if (fill < lowest) {
        lowest = fill;
        best = size;
      }
    }
    return best;
  }

  /** Adds a board made elsewhere (e.g. by a worker thread). */
  add(board: Board): void {
    this.pools.get(board.size)?.push(board);
  }

  /** Generates on this thread until the budget is spent. Returns true when every pool is full. */
  refill(budgetMs: number, clock: () => number = () => performance.now()): boolean {
    const deadline = clock() + budgetMs;
    while (clock() < deadline) {
      const size = this.wanted();
      if (size === null) return true;
      this.pools.get(size)!.push(this.generate(size));
    }
    return this.wanted() === null;
  }

  private generate(size: number): Board {
    for (;;) {
      const puzzle = generatePuzzle(size, this.rng);
      if (puzzle) return puzzle.board;
    }
  }
}
