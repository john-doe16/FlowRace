// Standalone implementations of the Auth and PlayerStore ports.
// Swap these for the host app's real accounts and database.
import { randomBytes, randomUUID } from 'node:crypto';
import type { LeaderboardEntry, MatchResult } from '../../shared/protocol.ts';
import type { Auth, Identity, PlayerStore, Profile } from '../core/ports.ts';
import { START_RATING } from '../core/rating.ts';

/** Anonymous guests: the first hello mints a token, later hellos with it resume the same player. */
export class GuestAuth implements Auth {
  private readonly tokens = new Map<string, string>();

  async identify(hello: { token?: string; name: string }): Promise<Identity> {
    const known = hello.token ? this.tokens.get(hello.token) : undefined;
    if (known && hello.token) return { playerId: known, token: hello.token, name: hello.name };
    const token = randomBytes(24).toString('base64url');
    const playerId = randomUUID();
    this.tokens.set(token, playerId);
    return { playerId, token, name: hello.name };
  }
}

/** Keeps ratings and recent results in memory; everything resets on restart. */
export class MemoryStore implements PlayerStore {
  private readonly profiles = new Map<string, Profile & { name: string }>();
  readonly recent: MatchResult[] = [];

  async getProfile(playerId: string): Promise<Profile> {
    const p = this.profiles.get(playerId);
    return p ? { rating: p.rating, games: p.games } : { rating: START_RATING, games: 0 };
  }

  async saveProfile(playerId: string, profile: Profile & { name: string }): Promise<void> {
    this.profiles.set(playerId, { ...profile });
  }

  async recordMatch(result: MatchResult): Promise<void> {
    this.recent.push(result);
    if (this.recent.length > 200) this.recent.shift();
  }

  async leaderboard(limit: number): Promise<LeaderboardEntry[]> {
    return this.ranked()
      .slice(0, limit)
      .map(([id, p], i) => ({ rank: i + 1, id, name: p.name, rating: p.rating, games: p.games }));
  }

  async rankOf(playerId: string): Promise<number | null> {
    const i = this.ranked().findIndex(([id]) => id === playerId);
    return i === -1 ? null : i + 1;
  }

  private ranked() {
    return [...this.profiles]
      .filter(([, p]) => p.games > 0)
      .sort(([, a], [, b]) => b.rating - a.rating || b.games - a.games);
  }
}
