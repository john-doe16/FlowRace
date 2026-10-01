// Breaks down why board generation attempts fail, per size.
// Usage: node scripts/diagnose-generator.ts [attemptsPerSize]
import { colorRange, randomCover, type CoverStats } from '../server/core/generator.ts';
import { mulberry32 } from '../server/core/rng.ts';
import { solve } from '../server/core/solver.ts';

const attempts = Number(process.argv[2] ?? 300);
for (const size of [9, 10, 11]) {
  const rng = mulberry32(5);
  const s = { noCover: 0, budget: 0, multiple: 0, unique: 0, coverMs: 0, solveMs: 0 };
  const nodes: number[] = [];
  const cs: CoverStats = { tooMany: 0, tooShort: 0, colours: [] };
  for (let i = 0; i < attempts; i++) {
    let t = performance.now();
    const cover = randomCover(size, rng, cs);
    s.coverMs += performance.now() - t;
    if (!cover) {
      s.noCover++;
      continue;
    }
    const dots = cover.map((p): [number, number] => [p[0], p[p.length - 1]]);
    t = performance.now();
    const r = solve(size, dots, 2, 50_000);
    s.solveMs += performance.now() - t;
    if (!r.complete) s.budget++;
    else if (r.count > 1) s.multiple++;
    else {
      s.unique++;
      nodes.push(r.nodes);
    }
  }
  nodes.sort((a, b) => a - b);
  console.log(
    `${size}x${size}: unique ${s.unique}, no cover ${s.noCover}, out of budget ${s.budget}, multiple ${s.multiple}, ` +
      `cover ${Math.round(s.coverMs)}ms, solve ${Math.round(s.solveMs)}ms, nodes p50 ${nodes[nodes.length >> 1]} max ${nodes.at(-1)}`,
  );
  cs.colours.sort((a, b) => a - b);
  console.log(
    `   cover rejects: too many colours ${cs.tooMany}, short paths ${cs.tooShort}; ` +
      `colour range ${colorRange(size)}; stuck at p10 ${cs.colours[Math.floor(cs.colours.length * 0.1)]} p50 ${cs.colours[cs.colours.length >> 1]} p90 ${cs.colours[Math.floor(cs.colours.length * 0.9)]}`,
  );
}
