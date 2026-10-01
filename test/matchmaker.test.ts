import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Matchmaker } from '../server/core/matchmaker.ts';
import { eloUpdate } from '../server/core/rating.ts';

import type { QueueOptions } from '../shared/rules.ts';

const opt7: QueueOptions = { mode: 'race', sizeMode: 7, durationSec: 120, twists: [] };
const opt9: QueueOptions = { mode: 'race', sizeMode: 9, durationSec: 120, twists: [] };

test('only pairs players who picked the same options', () => {
  const mm = new Matchmaker();
  mm.join({ playerId: 'a', rating: 1200, options: opt7, joinedAt: 0 });
  mm.join({ playerId: 'b', rating: 1200, options: opt9, joinedAt: 0 });
  assert.equal(mm.tick(1000).length, 0);
  assert.deepEqual(mm.counts(), { 'race:7:120': 1, 'race:9:120': 1 });
  mm.join({ playerId: 'c', rating: 1210, options: opt9, joinedAt: 500 });
  const pairs = mm.tick(1000);
  assert.deepEqual(pairs.map(([x, y]) => [x.playerId, y.playerId]), [['b', 'c']]);
  assert.equal(mm.get('b'), undefined);
  assert.ok(mm.get('a'));
});

test('race and tug of war queue separately', () => {
  const mm = new Matchmaker();
  mm.join({ playerId: 'a', rating: 1200, options: opt7, joinedAt: 0 });
  mm.join({ playerId: 'b', rating: 1200, options: { ...opt7, mode: 'tug' }, joinedAt: 0 });
  assert.equal(mm.tick(1000).length, 0);
});

test('rating window widens with waiting time', () => {
  const mm = new Matchmaker();
  mm.join({ playerId: 'a', rating: 1000, options: opt7, joinedAt: 0 });
  mm.join({ playerId: 'b', rating: 1400, options: opt7, joinedAt: 0 });
  assert.equal(mm.tick(1000).length, 0);
  // 400 gap needs (400 - 100) / 25 = 12s of waiting.
  assert.equal(mm.tick(11_000).length, 0);
  assert.equal(mm.tick(12_000).length, 1);
});

test('prefers the closest rating', () => {
  const mm = new Matchmaker();
  mm.join({ playerId: 'a', rating: 1200, options: opt7, joinedAt: 0 });
  mm.join({ playerId: 'far', rating: 1290, options: opt7, joinedAt: 1 });
  mm.join({ playerId: 'near', rating: 1210, options: opt7, joinedAt: 2 });
  const [[x, y]] = mm.tick(100);
  assert.deepEqual([x.playerId, y.playerId], ['a', 'near']);
});

test('elo moves ratings in opposite directions', () => {
  const fresh = { rating: 1200, games: 0 };
  assert.deepEqual(eloUpdate(fresh, fresh, 1), [1220, 1180]);
  assert.deepEqual(eloUpdate(fresh, fresh, 0.5), [1200, 1200]);
});
