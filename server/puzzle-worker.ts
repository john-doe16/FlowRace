// Generates boards off the main thread: big boards take up to a few hundred
// ms each, which would otherwise stall every live race while they're made.
// Receives a board size, replies with a unique-solution Board.
import { parentPort } from 'node:worker_threads';
import { generatePuzzle } from './core/generator.ts';
import { mulberry32 } from './core/rng.ts';

const rng = mulberry32((Math.random() * 2 ** 32) >>> 0);

parentPort!.on('message', (size: number) => {
  for (;;) {
    const puzzle = generatePuzzle(size, rng);
    if (puzzle) {
      parentPort!.postMessage(puzzle.board);
      return;
    }
  }
});
