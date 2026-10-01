import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMessage } from '../shared/protocol.ts';
import { COUNTDOWN_MS, minSolveMs, pointsFor, SKIP_LOCKOUT_MS, SUBMIT_GRACE_MS, type QueueOptions } from '../shared/rules.ts';
import { Match } from '../server/core/match.ts';
import { testPuzzles } from './helpers.ts';

function setup(options: QueueOptions = { mode: 'race', sizeMode: 5, durationSec: 60, twists: [] }) {
  const puzzles = testPuzzles(42);
  const sent: { to: string; msg: ServerMessage }[] = [];
  const t0 = 1_000_000;
  const match = new Match({
    id: 'm1',
    options,
    ranked: true,
    lobbyCode: null,
    players: [
      { id: 'a', name: 'Ann', rating: 1200 },
      { id: 'b', name: 'Bo', rating: 1200 },
    ],
    now: t0,
    puzzles,
    emit: (to, msg) => sent.push({ to, msg }),
  });
  match.start(t0);
  const live = t0 + COUNTDOWN_MS;
  const solve = (player: string, index: number, at: number) =>
    match.submit(player, index, puzzles.solutionOf(match.boardAt(index)), at);
  const last = (to: string, type: ServerMessage['type']) =>
    sent.filter((s) => s.to === to && s.msg.type === type).at(-1)?.msg;
  return { match, sent, live, solve, last, puzzles };
}

test('both players get the same first two boards', () => {
  const { last } = setup();
  const a = last('a', 'match.state') as Extract<ServerMessage, { type: 'match.state' }>;
  const b = last('b', 'match.state') as Extract<ServerMessage, { type: 'match.state' }>;
  assert.deepEqual(a.boards, b.boards);
  assert.deepEqual(a.boards.map((x) => x.index), [0, 1]);
});

test('a valid solve scores, advances and sends the board after next', () => {
  const { match, live, solve, last } = setup();
  solve('a', 0, live + 5000);
  const ack = last('a', 'match.ack') as Extract<ServerMessage, { type: 'match.ack' }>;
  assert.equal(ack.score, pointsFor(5));
  assert.equal(ack.boardIndex, 0);
  const board = last('a', 'match.board') as Extract<ServerMessage, { type: 'match.board' }>;
  assert.equal(board.index, 2);
  assert.equal(board.board.id, match.boardAt(2).id);
  // Opponent sees the new score but never the paths.
  const racer = last('b', 'match.racer') as Extract<ServerMessage, { type: 'match.racer' }>;
  assert.equal(racer.racer.score, pointsFor(5));
  assert.equal(racer.racer.boardIndex, 1);
});

test('rejects solves before the start, for the wrong board, or too fast', () => {
  const { live, solve, last, match } = setup();
  solve('a', 0, live - 10);
  assert.equal((last('a', 'match.reject') as any).reason, 'not-live');
  solve('a', 1, live + 5000);
  assert.equal((last('a', 'match.reject') as any).reason, 'wrong-board');
  solve('a', 0, live + minSolveMs(5) - 1);
  assert.equal((last('a', 'match.reject') as any).reason, 'too-fast');
  assert.equal(match.flagsOf('a'), 1);
  // A reject is followed by a resync snapshot.
  assert.equal((last('a', 'match.state') as any).you.boardIndex, 0);
});

test('rejects invalid paths', () => {
  const { match, live, last } = setup();
  match.submit('a', 0, [[0, 1]], live + 5000);
  assert.equal((last('a', 'match.reject') as any).reason, 'invalid');
});

test('skip locks the player out before the next board counts', () => {
  const { match, live, solve, last } = setup();
  match.skip('a', 0, live + 1000);
  const ack = last('a', 'match.ack') as Extract<ServerMessage, { type: 'match.ack' }>;
  assert.equal(ack.skipped, true);
  assert.equal(ack.lockedUntil, live + 1000 + SKIP_LOCKOUT_MS);
  solve('a', 1, live + 2000);
  assert.equal((last('a', 'match.reject') as any).reason, 'locked');
  // Solve timer starts when the lock ends, so a solve right after it is "too fast".
  solve('a', 1, ack.lockedUntil + 10);
  assert.equal((last('a', 'match.reject') as any).reason, 'too-fast');
  solve('a', 1, ack.lockedUntil + 5000);
  assert.equal((last('a', 'match.ack') as any).score, pointsFor(5));
});

test('higher score wins; equal scores go to whoever got there first', () => {
  const { match, live, solve } = setup();
  solve('a', 0, live + 4000);
  solve('b', 0, live + 3000);
  solve('a', 1, live + 8000);
  assert.equal(match.tick(match.endsAt), false);
  assert.equal(match.tick(match.endsAt + SUBMIT_GRACE_MS), true);
  assert.deepEqual(match.standings().map((s) => [s.id, s.place]), [['a', 1], ['b', 2]]);

  const tie = setup();
  tie.solve('a', 0, tie.live + 4000);
  tie.solve('b', 0, tie.live + 3000);
  assert.deepEqual(tie.match.standings().map((s) => s.id), ['b', 'a']);
});

test('nobody scoring is a draw', () => {
  const { match } = setup();
  assert.deepEqual(match.standings().map((s) => s.place), [1, 1]);
});

test('submissions after the grace window are rejected', () => {
  const { match, solve, last } = setup();
  solve('a', 0, match.endsAt + SUBMIT_GRACE_MS + 1);
  assert.equal((last('a', 'match.reject') as any).reason, 'time-up');
});

test('ramp mode grows the boards', () => {
  const { match } = setup({ mode: 'race', sizeMode: 'ramp', durationSec: 60, twists: [] });
  assert.deepEqual([0, 3, 6, 10, 15].map((i) => match.boardAt(i).size), [5, 6, 7, 8, 9]);
});

test('tug of war ends the moment someone is three boards ahead', () => {
  const { match, live, solve, last } = setup({ mode: 'tug', sizeMode: 5, durationSec: 60, twists: [] });
  assert.equal((last('a', 'match.state') as any).tugTarget, 3);
  solve('a', 0, live + 2000);
  solve('b', 0, live + 2500);
  solve('a', 1, live + 4000);
  solve('a', 2, live + 6000);
  assert.equal(match.tick(live + 6100), false, 'lead of 2 is not enough');
  solve('a', 3, live + 8000);
  assert.equal(match.tick(live + 8100), true, 'lead of 3 wins well before the clock');
  assert.deepEqual(match.standings().map((s) => [s.id, s.score]), [['a', 4], ['b', 1]]);
  solve('b', 1, live + 8200);
  assert.equal((last('b', 'match.reject') as any).reason, 'time-up');
});
