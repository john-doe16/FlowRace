// Wire protocol: JSON messages over a WebSocket. Every message has a `type`.
// This file is the contract between client and server; the server core
// never depends on how messages are transported.
import type { Board, Paths } from './board.ts';
import type { QueueOptions } from './rules.ts';

export const PROTOCOL_VERSION = 1;

export type ClientMessage =
  | { type: 'hello'; v: number; token?: string; name: string }
  | { type: 'queue.join'; options: QueueOptions }
  | { type: 'queue.leave' }
  | { type: 'lobby.create'; options: QueueOptions }
  | { type: 'lobby.join'; code: string }
  | { type: 'lobby.leave' }
  | { type: 'lobby.options'; options: QueueOptions }
  | { type: 'lobby.ready'; ready: boolean }
  | { type: 'match.progress'; boardIndex: number; filled: number }
  | { type: 'match.submit'; boardIndex: number; paths: Paths }
  | { type: 'match.skip'; boardIndex: number }
  | { type: 'practice.start'; options: QueueOptions }
  | { type: 'practice.stop' }
  | { type: 'leaderboard.get' };

export interface LeaderboardEntry {
  rank: number;
  id: string;
  name: string;
  rating: number;
  games: number;
}

export interface PlayerInfo {
  id: string;
  name: string;
  rating: number;
}

/** What everyone in a match can see about a racer. Never includes their paths. */
export interface RacerStatus {
  id: string;
  score: number;
  solved: number;
  boardIndex: number;
  /** Cells filled on their current board. */
  filled: number;
  /** Size of their current board, so a fill meter can be drawn. */
  boardSize: number;
  connected: boolean;
}

export interface IndexedBoard {
  index: number;
  board: Board;
}

export interface KnockoutState {
  /** 0-based round; everyone still in plays board `round`. */
  round: number;
  alive: string[];
  /** In elimination order. */
  eliminated: { id: string; round: number }[];
  /** Who went out at the end of the previous round, for the between-rounds banner. */
  lastOut: string[];
}

/**
 * Full match state for one player. Sent at start, on reconnect, after a
 * rejected move, and (in knockout) at the start of every round.
 */
export interface MatchSnapshot {
  matchId: string;
  options: QueueOptions;
  ranked: boolean;
  /** Solo run against the clock. */
  practice: boolean;
  lobbyCode: string | null;
  serverNow: number;
  startsAt: number;
  endsAt: number;
  racers: PlayerInfo[];
  status: RacerStatus[];
  you: { boardIndex: number; score: number; lockedUntil: number };
  /** Your current board and the one after it, so the next board loads instantly. */
  boards: IndexedBoard[];
  /** Tug of war: the points lead that wins outright; null in other modes. */
  tugTarget: number | null;
  /** Knockout round state; null in other modes. In knockout, startsAt/endsAt are the current round's. */
  knockout: KnockoutState | null;
}

export interface Standing {
  id: string;
  name: string;
  score: number;
  solved: number;
  skipped: number;
  place: number;
}

export interface MatchResult {
  matchId: string;
  options: QueueOptions;
  ranked: boolean;
  practice: boolean;
  lobbyCode: string | null;
  standings: Standing[];
  /** Null on a draw. */
  winnerId: string | null;
  /** Rating changes for ranked matches. */
  ratings: Record<string, { before: number; after: number }> | null;
}

export interface LobbyMember extends PlayerInfo {
  ready: boolean;
  connected: boolean;
}

export interface LobbyView {
  code: string;
  hostId: string;
  options: QueueOptions;
  members: LobbyMember[];
  matchId: string | null;
}

export type RejectReason = 'not-live' | 'time-up' | 'wrong-board' | 'locked' | 'invalid' | 'too-fast';

export type ServerMessage =
  | { type: 'welcome'; v: number; token: string; player: PlayerInfo & { games: number }; serverNow: number }
  | { type: 'queue.stats'; counts: Record<string, number> }
  | { type: 'queue.status'; queued: QueueOptions | null; since: number | null }
  | { type: 'lobby.state'; lobby: LobbyView | null }
  | ({ type: 'match.state' } & MatchSnapshot)
  | { type: 'match.board'; matchId: string; index: number; board: Board }
  | {
      type: 'match.ack';
      matchId: string;
      boardIndex: number;
      skipped: boolean;
      score: number;
      lockedUntil: number;
    }
  | { type: 'match.reject'; matchId: string; boardIndex: number; reason: RejectReason }
  | { type: 'match.racer'; matchId: string; racer: RacerStatus }
  | { type: 'match.result'; result: MatchResult }
  | {
      type: 'leaderboard';
      entries: LeaderboardEntry[];
      /** Your own rank; null until you've played a ranked match. */
      you: { rank: number | null; rating: number; games: number };
    }
  | { type: 'error'; code: string; message: string };
