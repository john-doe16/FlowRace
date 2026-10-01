import { isAdjacent, type Board, type Cell, type Paths } from '../shared/board.ts';

/**
 * Local drawing state for one board, following Flow's touch rules:
 * - press a dot to start (or restart) that colour from it;
 * - press a pipe to pick it up from that point;
 * - drag over your own pipe to pull it back;
 * - drag over another colour's pipe to cut it;
 * - dots of other colours block you, and a connected pipe can only shrink.
 */
export class PlayState {
  readonly board: Board;
  readonly size: number;
  /** paths[color]: cells from the dot it was started at. Empty if untouched. */
  readonly paths: Cell[][];
  /** Colour currently being drawn, or null. */
  active: number | null = null;

  private readonly dotColor: Int16Array;
  private readonly owner: Int16Array;
  /** Board states before each stroke or clear, for undo. */
  private readonly history: Cell[][][] = [];

  constructor(board: Board) {
    this.board = board;
    this.size = board.size;
    const n = board.size * board.size;
    this.paths = board.dots.map(() => []);
    this.dotColor = new Int16Array(n).fill(-1);
    this.owner = new Int16Array(n).fill(-1);
    board.dots.forEach(([a, b], color) => {
      this.dotColor[a] = color;
      this.dotColor[b] = color;
    });
  }

  dotAt(cell: Cell): number {
    return this.dotColor[cell];
  }

  /** Colour whose pipe covers this cell (dots included once a pipe leaves them), or -1. */
  ownerAt(cell: Cell): number {
    return this.owner[cell];
  }

  isComplete(color: number): boolean {
    const p = this.paths[color];
    if (p.length < 2) return false;
    const last = p[p.length - 1];
    return last !== p[0] && this.dotColor[last] === color;
  }

  completedCount(): number {
    let count = 0;
    for (let c = 0; c < this.paths.length; c++) if (this.isComplete(c)) count++;
    return count;
  }

  /** Cells covered by pipes; what the opponent's fill meter shows. */
  filledCount(): number {
    let count = 0;
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] >= 0) count++;
    return count;
  }

  isSolved(): boolean {
    return this.completedCount() === this.paths.length && this.filledCount() === this.owner.length;
  }

  solution(): Paths {
    return this.paths.map((p) => p.slice());
  }

  begin(cell: Cell): boolean {
    const dot = this.dotColor[cell];
    if (dot >= 0 || this.owner[cell] >= 0) this.remember();
    if (dot >= 0) {
      this.paths[dot].length = 0;
      this.paths[dot].push(cell);
      this.active = dot;
      this.rebuild();
      return true;
    }
    const color = this.owner[cell];
    if (color >= 0) {
      const p = this.paths[color];
      p.length = p.indexOf(cell) + 1;
      this.active = color;
      this.rebuild();
      return true;
    }
    return false;
  }

  /** Moves the active pipe's head towards the cell under the pointer. Returns true if anything changed. */
  drag(cell: Cell): boolean {
    if (this.active === null) return false;
    const p = this.paths[this.active];
    const back = p.indexOf(cell);
    if (back >= 0) {
      if (back === p.length - 1) return false;
      p.length = back + 1;
      this.rebuild();
      return true;
    }
    // Walk one cell at a time so fast swipes don't skip squares.
    let changed = false;
    for (let guard = 0; guard < this.size * 2; guard++) {
      const head = p[p.length - 1];
      if (head === cell) break;
      if (!this.step(this.active, this.toward(head, cell))) break;
      changed = true;
    }
    if (changed) this.rebuild();
    return changed;
  }

  end(): void {
    this.active = null;
  }

  clear(): void {
    if (this.paths.some((p) => p.length > 1)) this.remember();
    for (const p of this.paths) p.length = 0;
    this.active = null;
    this.rebuild();
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /** Restores the board to before the last stroke (or clear). Returns false if there's nothing to undo. */
  undo(): boolean {
    const previous = this.history.pop();
    if (!previous) return false;
    previous.forEach((p, color) => {
      this.paths[color].length = 0;
      this.paths[color].push(...p);
    });
    this.active = null;
    this.rebuild();
    return true;
  }

  private remember(): void {
    const snapshot = this.paths.map((p) => p.slice());
    // A stroke that changed nothing (e.g. tapping a dot twice) shouldn't need two undos.
    const last = this.history.at(-1);
    if (last && last.every((p, c) => p.length === snapshot[c].length && p.every((x, i) => x === snapshot[c][i]))) return;
    this.history.push(snapshot);
    if (this.history.length > 100) this.history.shift();
  }

  private toward(from: Cell, to: Cell): Cell {
    const s = this.size;
    const dr = Math.floor(to / s) - Math.floor(from / s);
    const dc = (to % s) - (from % s);
    if (Math.abs(dr) >= Math.abs(dc)) return from + Math.sign(dr) * s;
    return from + Math.sign(dc);
  }

  private step(color: number, next: Cell): boolean {
    const p = this.paths[color];
    if (!isAdjacent(this.size, p[p.length - 1], next)) return false;
    if (this.isComplete(color)) return false;
    const dot = this.dotColor[next];
    if (dot >= 0 && dot !== color) return false;
    const other = this.owner[next];
    if (other >= 0 && other !== color) {
      const q = this.paths[other];
      q.length = q.indexOf(next);
    }
    p.push(next);
    // Keep ownership current for the next step of a multi-cell drag.
    this.rebuild();
    return true;
  }

  private rebuild(): void {
    this.owner.fill(-1);
    this.paths.forEach((p, color) => {
      if (p.length < 2) return;
      for (const cell of p) this.owner[cell] = color;
    });
  }
}
