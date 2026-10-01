// Everything the core needs from the outside world. The standalone server
// implements these in server/adapters; a host app (e.g. the kernel app)
// provides its own implementations and drives GameServer the same way.
import type { Board } from '../../shared/board.ts';
import type { LeaderboardEntry, MatchResult, ServerMessage } from '../../shared/protocol.ts';

/** Opaque id for one client connection, assigned by the transport. */
export type ConnId = string;

export interface Transport {
  send(conn: ConnId, msg: ServerMessage): void;
}

export interface Identity {
  playerId: string;
  /** Secret the client stores to resume as the same player after a reconnect. */
  token: string;
  name: string;
}

export interface Auth {
  identify(hello: { token?: string; name: string }): Promise<Identity>;
}

export interface Profile {
  rating: number;
  games: number;
}

export interface PlayerStore {
  getProfile(playerId: string): Promise<Profile>;
  /** Also called on every sign-in, so the leaderboard shows current names. */
  saveProfile(playerId: string, profile: Profile & { name: string }): Promise<void>;
  recordMatch(result: MatchResult): Promise<void>;
  /** Highest-rated players with at least one ranked game. */
  leaderboard(limit: number): Promise<LeaderboardEntry[]>;
  /** 1-based rank, or null if the player has no ranked games yet. */
  rankOf(playerId: string): Promise<number | null>;
}

export interface Clock {
  now(): number;
}

export interface PuzzleSource {
  /** Returns a fresh unique-solution board of the given size. */
  next(size: number): Board;
}
