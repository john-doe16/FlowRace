/** A cell is addressed by its index: row * size + col. */
export type Cell = number;

/** A puzzle as sent to clients. Never includes a solution. */
export interface Board {
  id: string;
  size: number;
  /** dots[color] = the two endpoint cells of that color. */
  dots: [Cell, Cell][];
}

/** paths[color] = cells from one endpoint to the other, inclusive, in drawing order. */
export type Paths = Cell[][];

export const MIN_SIZE = 5;
export const MAX_SIZE = 11;
export const MAX_COLORS = 16;

const tables = new Map<number, Cell[][]>();

/** Orthogonal neighbours of every cell, cached per board size. */
export function neighborTable(size: number): Cell[][] {
  let table = tables.get(size);
  if (!table) {
    table = [];
    for (let cell = 0; cell < size * size; cell++) {
      const r = Math.floor(cell / size);
      const c = cell % size;
      const out: Cell[] = [];
      if (r > 0) out.push(cell - size);
      if (r < size - 1) out.push(cell + size);
      if (c > 0) out.push(cell - 1);
      if (c < size - 1) out.push(cell + 1);
      table.push(out);
    }
    tables.set(size, table);
  }
  return table;
}

export function isAdjacent(size: number, a: Cell, b: Cell): boolean {
  const dr = Math.abs(Math.floor(a / size) - Math.floor(b / size));
  const dc = Math.abs((a % size) - (b % size));
  return dr + dc === 1;
}
