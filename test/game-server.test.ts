import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, type ServerMessage } from '../shared/protocol.ts';
import { COUNTDOWN_MS, SUBMIT_GRACE_MS } from '../shared/rules.ts';
import { GuestAuth, MemoryStore } from '../server/adapters/memory.ts';
import { GameServer } from '../server/core/game-server.ts';
import { testPuzzles } from './helpers.ts';

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

function setup() {
  let now = 1_000_000;
  const inbox = new Map<string, ServerMessage[]>();
  const puzzles = testPuzzles(3);
  const store = new MemoryStore();
  const server = new GameServer({
    transport: { send: (conn, msg) => inbox.get(conn)?.push(msg) },
    auth: new GuestAuth(),
    store,
    clock: { now: () => now },
    puzzles,
  });

  const client = async (conn: string, name: string, token?: string) => {
    inbox.set(conn, []);
    server.handleConnect(conn);
    await server.handleMessage(conn, { type: 'hello', v: PROTOCOL_VERSION, name, token });
    const send = (msg: object) => server.handleMessage(conn, msg);
    const last = <T extends ServerMessage['type']>(type: T) =>
      inbox.get(conn)!.filter((m) => m.type === type).at(-1) as Msg<T> | undefined;
    return { conn, send, last, welcome: last('welcome')! };
  };

  return {
    server,
    store,
    puzzles,
    client,
    advance(ms: number) {
      now += ms;
      server.tick();
    },
  };
}

test('two queued players with the same options race, and the winner gains rating', async () => {
  const { client, advance, puzzles, store } = setup();
  const ann = await client('c1', 'Ann');
  const bo = await client('c2', 'Bo');
  const options = { sizeMode: 6, durationSec: 60 };
  await ann.send({ type: 'queue.join', options });
  await bo.send({ type: 'queue.join', options: { sizeMode: 7, durationSec: 60 } });
  advance(100);
  assert.equal(ann.last('match.state'), undefined, 'different options must not match');

  await bo.send({ type: 'queue.join', options });
  advance(100);
  const start = ann.last('match.state')!;
  assert.ok(start);
  assert.equal(start.ranked, true);
  assert.equal(bo.last('match.state')!.matchId, start.matchId);
  assert.equal(ann.last('queue.status')!.queued, null);

  advance(COUNTDOWN_MS + 5000);
  const board = start.boards[0].board;
  await ann.send({ type: 'match.submit', boardIndex: 0, paths: puzzles.solutionOf(board) });
  assert.equal(ann.last('match.ack')!.score, 2);
  assert.equal(bo.last('match.racer')!.racer.score, 2);

  advance(60_000 + SUBMIT_GRACE_MS);
  const result = ann.last('match.result')!.result;
  assert.equal(result.winnerId, ann.welcome.player.id);
  assert.deepEqual(result.ratings![ann.welcome.player.id], { before: 1200, after: 1220 });
  assert.deepEqual(bo.last('match.result')!.result, result);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await store.getProfile(ann.welcome.player.id), { rating: 1220, games: 1 });
});

test('friends lobby: join by code, ready up, unranked race, back to lobby after', async () => {
  const { client, advance } = setup();
  const ann = await client('c1', 'Ann');
  const bo = await client('c2', 'Bo');
  await ann.send({ type: 'lobby.create', options: { sizeMode: 'ramp', durationSec: 60 } });
  const code = ann.last('lobby.state')!.lobby!.code;
  assert.match(code, /^[A-Z2-9]{6}$/);

  await bo.send({ type: 'lobby.join', code: code.toLowerCase() });
  assert.equal(ann.last('lobby.state')!.lobby!.members.length, 2);

  // Only the host can change settings, and doing so clears ready flags.
  await bo.send({ type: 'lobby.options', options: { sizeMode: 5, durationSec: 60 } });
  assert.equal(bo.last('error')!.code, 'not-host');
  await bo.send({ type: 'lobby.ready', ready: true });
  await ann.send({ type: 'lobby.options', options: { sizeMode: 5, durationSec: 60 } });
  assert.ok(ann.last('lobby.state')!.lobby!.members.every((m) => !m.ready));

  await ann.send({ type: 'lobby.ready', ready: true });
  await bo.send({ type: 'lobby.ready', ready: true });
  const start = bo.last('match.state')!;
  assert.equal(start.ranked, false);
  assert.equal(start.lobbyCode, code);
  assert.equal(start.boards[0].board.size, 5);

  advance(COUNTDOWN_MS + 60_000 + SUBMIT_GRACE_MS);
  const result = ann.last('match.result')!.result;
  assert.equal(result.ratings, null);
  assert.equal(result.winnerId, null);
  const lobby = ann.last('lobby.state')!.lobby!;
  assert.equal(lobby.matchId, null);
  assert.equal(lobby.members.length, 2);
});

test('a player who reconnects mid-race resumes where they were', async () => {
  const { client, advance, server, puzzles } = setup();
  const ann = await client('c1', 'Ann');
  const bo = await client('c2', 'Bo');
  const options = { sizeMode: 5, durationSec: 120 };
  await ann.send({ type: 'queue.join', options });
  await bo.send({ type: 'queue.join', options });
  advance(100);
  const start = ann.last('match.state')!;
  advance(COUNTDOWN_MS + 3000);
  await ann.send({ type: 'match.submit', boardIndex: 0, paths: puzzles.solutionOf(start.boards[0].board) });

  server.handleDisconnect('c1');
  assert.equal(bo.last('match.racer')!.racer.connected, false);
  advance(2000);

  const again = await client('c3', 'Ann', ann.welcome.token);
  assert.equal(again.welcome.player.id, ann.welcome.player.id);
  const resumed = again.last('match.state')!;
  assert.equal(resumed.matchId, start.matchId);
  assert.equal(resumed.you.boardIndex, 1);
  assert.equal(resumed.you.score, 1);
  assert.deepEqual(resumed.boards.map((b) => b.index), [1, 2]);
  assert.equal(bo.last('match.racer')!.racer.connected, true);
});

test('practice: a solo run that scores, can be ended early, and never touches rating', async () => {
  const { client, advance, puzzles, store } = setup();
  const ann = await client('c1', 'Ann');
  await ann.send({ type: 'practice.start', options: { sizeMode: 5, durationSec: 180 } });
  const start = ann.last('match.state')!;
  assert.equal(start.practice, true);
  assert.equal(start.ranked, false);
  assert.equal(start.racers.length, 1);

  advance(COUNTDOWN_MS + 2000);
  await ann.send({ type: 'match.submit', boardIndex: 0, paths: puzzles.solutionOf(start.boards[0].board) });
  assert.equal(ann.last('match.ack')!.score, 1);

  await ann.send({ type: 'practice.stop' });
  const result = ann.last('match.result')!.result;
  assert.equal(result.practice, true);
  assert.equal(result.ratings, null);
  assert.equal(result.standings[0].score, 1);
  assert.deepEqual(await store.getProfile(ann.welcome.player.id), { rating: 1200, games: 0 });

  // Free to queue again straight away.
  await ann.send({ type: 'queue.join', options: { sizeMode: 5, durationSec: 60 } });
  assert.ok(ann.last('queue.status')!.queued);
});

test('leaderboard lists ranked players by rating with your own rank', async () => {
  const { client, advance, puzzles } = setup();
  const ann = await client('c1', 'Ann');
  const bo = await client('c2', 'Bo');
  const cy = await client('c3', 'Cy');
  await cy.send({ type: 'leaderboard.get' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(cy.last('leaderboard')!.entries, []);
  assert.equal(cy.last('leaderboard')!.you.rank, null);

  const options = { sizeMode: 5, durationSec: 60 };
  await ann.send({ type: 'queue.join', options });
  await bo.send({ type: 'queue.join', options });
  advance(100);
  const start = ann.last('match.state')!;
  advance(COUNTDOWN_MS + 2000);
  await ann.send({ type: 'match.submit', boardIndex: 0, paths: puzzles.solutionOf(start.boards[0].board) });
  advance(60_000 + SUBMIT_GRACE_MS);
  await new Promise((r) => setImmediate(r));

  await bo.send({ type: 'leaderboard.get' });
  await new Promise((r) => setImmediate(r));
  const board = bo.last('leaderboard')!;
  assert.deepEqual(
    board.entries.map((e) => [e.rank, e.name, e.rating]),
    [[1, 'Ann', 1220], [2, 'Bo', 1180]],
  );
  assert.deepEqual(board.you, { rank: 2, rating: 1180, games: 1 });
});

test('knockout is lobby-only, queues drop twists, and tug lobbies need exactly two', async () => {
  const { client } = setup();
  const ann = await client('c1', 'Ann');
  await ann.send({ type: 'queue.join', options: { mode: 'knockout', sizeMode: 5, durationSec: 60 } });
  assert.equal(ann.last('error')!.code, 'mode');
  await ann.send({ type: 'queue.join', options: { mode: 'tug', sizeMode: 5, durationSec: 60, twists: ['fog'] } });
  assert.deepEqual(ann.last('queue.status')!.queued!.twists, []);
  await ann.send({ type: 'queue.leave' });

  const bo = await client('c2', 'Bo');
  const cy = await client('c3', 'Cy');
  await ann.send({ type: 'lobby.create', options: { mode: 'tug', sizeMode: 5, durationSec: 60, twists: ['spin', 'fog'] } });
  const code = ann.last('lobby.state')!.lobby!.code;
  assert.deepEqual(ann.last('lobby.state')!.lobby!.options.twists, ['fog', 'spin']);
  await bo.send({ type: 'lobby.join', code });
  await cy.send({ type: 'lobby.join', code });
  for (const p of [ann, bo, cy]) await p.send({ type: 'lobby.ready', ready: true });
  assert.equal(ann.last('match.state'), undefined, 'three players cannot start a tug of war');

  await cy.send({ type: 'lobby.leave' });
  await ann.send({ type: 'lobby.ready', ready: true });
  const start = ann.last('match.state')!;
  assert.equal(start.tugTarget, 3);
  assert.deepEqual(start.options.twists, ['fog', 'spin']);
});

test('a tab taking over a lobby racer mid-race still returns to the lobby', async () => {
  const { client, advance, server } = setup();
  const ann = await client('c1', 'Ann');
  const bo = await client('c2', 'Bo');
  await ann.send({ type: 'lobby.create', options: { mode: 'tug', sizeMode: 5, durationSec: 60 } });
  await bo.send({ type: 'lobby.join', code: ann.last('lobby.state')!.lobby!.code });
  await ann.send({ type: 'lobby.ready', ready: true });
  await bo.send({ type: 'lobby.ready', ready: true });
  assert.ok(ann.last('match.state'));
  advance(COUNTDOWN_MS + 1000);

  // Ann's tab drops and comes back carrying Bo's token (shared browser storage).
  server.handleDisconnect('c1');
  const takeover = await client('c3', 'Bo', bo.welcome.token);
  assert.equal(bo.last('error')!.code, 'replaced');
  server.handleDisconnect('c2'); // The replaced tab closes its socket.
  assert.ok(takeover.last('lobby.state')!.lobby, 'resumed into the lobby');

  advance(60_000 + SUBMIT_GRACE_MS);
  assert.ok(takeover.last('match.result'));
  const lobby = takeover.last('lobby.state')!.lobby;
  assert.ok(lobby, 'still in the lobby after the race');
  assert.deepEqual(lobby.members.map((m) => m.name), ['Bo']);
});

test('cannot queue while in a lobby, and malformed messages are refused', async () => {
  const { client } = setup();
  const ann = await client('c1', 'Ann');
  await ann.send({ type: 'lobby.create', options: { sizeMode: 7, durationSec: 120 } });
  await ann.send({ type: 'queue.join', options: { sizeMode: 7, durationSec: 120 } });
  assert.equal(ann.last('error')!.code, 'in-lobby');
  await ann.send({ type: 'queue.join', options: { sizeMode: 12, durationSec: 120 } });
  assert.equal(ann.last('error')!.code, 'bad-message');
});
