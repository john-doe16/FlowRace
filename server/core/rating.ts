export const START_RATING = 1200;

/** New players move faster so they reach their real rating sooner. */
export function kFactor(games: number): number {
  return games < 10 ? 40 : 20;
}

export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** Elo update for a 1v1. scoreA is 1 for an A win, 0.5 for a draw, 0 for a loss. */
export function eloUpdate(
  a: { rating: number; games: number },
  b: { rating: number; games: number },
  scoreA: number,
): [number, number] {
  const ea = expectedScore(a.rating, b.rating);
  const nextA = a.rating + kFactor(a.games) * (scoreA - ea);
  const nextB = b.rating + kFactor(b.games) * (1 - scoreA - (1 - ea));
  return [Math.round(nextA), Math.round(nextB)];
}
