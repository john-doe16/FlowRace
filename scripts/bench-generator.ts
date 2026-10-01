// Measures how long unique-solution board generation takes per size.
// Usage: node scripts/bench-generator.ts [boardsPerSize]
import { generatePuzzle } from '../server/core/generator.ts';
import { mulberry32 } from '../server/core/rng.ts';

const perSize = Number(process.argv[2] ?? 20);
const rng = mulberry32(12345);

for (const size of [5, 6, 7, 8, 9, 10, 11]) {
  const times: number[] = [];
  let failed = 0;
  let colors = 0;
  for (let i = 0; i < perSize; i++) {
    const t0 = performance.now();
    const puzzle = generatePuzzle(size, rng);
    times.push(performance.now() - t0);
    if (!puzzle) failed++;
    else colors += puzzle.board.dots.length;
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  console.log(
    `${size}x${size}: avg ${avg.toFixed(1)}ms  p50 ${times[times.length >> 1].toFixed(1)}ms  ` +
      `max ${times[times.length - 1].toFixed(1)}ms  avg colours ${(colors / (perSize - failed)).toFixed(1)}  failed ${failed}`,
  );
}
