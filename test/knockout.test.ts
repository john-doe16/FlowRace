import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage } from '../shared/protocol.ts';
import { COUNTDOWN_MS, SUBMIT_GRACE_MS } from '../shared/rules.ts';
import { KnockoutMatch } from '../server/core/knockout.ts';
import { testPuzzles } from './helpers.ts';

type State = Extract<ServerMessage, { type: 'match.state' }>;

function setup(players = ['a', 'b', 'c']) {
  const puzzles = testPuzzles(11);
  const sent: { to: string; msg: ServerMessage }[] = [];
  const t0 = 1_000_000;
  const match = new KnockoutMatch({
    id: 'k1',
    options: { mode: 'knockout', sizeMode: 5, durationSec: 60, twists: [] },
    ranked: false,
    lobbyCode: 'ABCDEF',
    players: players.map((id) => ({ id, name: id.toUpperCase(), rating: 1200 })),
    now: t0,
    puzzles,
    emit: (to, msg) => sent.push({ to, msg }),
  });
  match.start(t0);
  const state = (to: string) => sent.filter((s) => s.to === to && s.msg.type === 'match.state').at(-1)?.msg as State;
  const solve = (player: string, at: number) => {
    const s = state(player);
    match.submit(player, s.knockout!.round, puzzles.solutionOf(match.boardAt(s.knockout!.round)), at);
  };
  const last = (to: string, type: ServerMessage['type']) =>
    sent.filter((s) => s.to === to && s.msg.type === type).at(-1)?.msg;
  return { match, state, solve, last, live: t0 + COUNTDOWN_MS };
}

test('the last player to solve each round is knocked out', () => {
  const { match, state, solve, live } = setup();
  assert.equal(state('a').knockout!.round, 0);
  assert.equal(state('a').boards.length, 1, 'only the current board is sent');

  solve('a', live + 2000);
  solve('b', live + 3000);
  // C was last: round 1 starts with a countdown, and C is out.
  const next = state('a');
  assert.equal(next.knockout!.round, 1);
  assert.deepEqual(next.knockout!.alive, ['a', 'b']);
  assert.deepEqual(next.knockout!.lastOut, ['c']);
  assert.equal(next.startsAt, live + 3000 + COUNTDOWN_MS);
  assert.deepEqual(state('c').boards, [], 'knocked-out players just watch');

  const round2 = next.startsAt;
  solve('b', round2 + 2000);
  assert.equal(match.tick(round2 + 2100), true);
  assert.deepEqual(match.standings().map((s) => [s.id, s.place]), [['b', 1], ['a', 2], ['c', 3]]);
});

test('a knocked-out player cannot keep playing, and nobody can skip', () => {
  const { match, solve, last, live } = setup();
  solve('a', live + 2000);
  solve('b', live + 3000);
  match.submit('c', 0, [], live + 3500);
  assert.equal((last('c', 'match.reject') as any).reason, 'not-live');
  match.skip('a', 1, live + 7000);
  assert.equal((last('a', 'match.reject') as any).reason, 'locked');
});

test('when the round clock runs out, the least-filled player goes out', () => {
  const { match, state, live } = setup(['a', 'b']);
  match.progress('a', 0, 4);
  match.progress('b', 0, 9);
  assert.equal(match.tick(live + 60_000), false);
  assert.equal(match.tick(live + 60_000 + SUBMIT_GRACE_MS + 1), true);
  assert.deepEqual(match.standings().map((s) => [s.id, s.place]), [['b', 1], ['a', 2]]);
  assert.ok(state('a'));
});

test('if everyone left would go out together, they share the win', () => {
  const { match, live } = setup(['a', 'b']);
  assert.equal(match.tick(live + 60_000 + SUBMIT_GRACE_MS + 1), true);
  assert.deepEqual(match.standings().map((s) => s.place), [1, 1]);
});
