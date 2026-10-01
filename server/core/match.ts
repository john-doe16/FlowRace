import type { Board, Paths } from '../../shared/board.ts';
import type {
  IndexedBoard,
  MatchSnapshot,
  PlayerInfo,
  RacerStatus,
  RejectReason,
  ServerMessage,
  Standing,
} from '../../shared/protocol.ts';
import {
  boardSizeAt,
  COUNTDOWN_MS,
  minSolveMs,
  pointsFor,
  SKIP_LOCKOUT_MS,
  SUBMIT_GRACE_MS,
  tugTarget,
  type QueueOptions,
} from '../../shared/rules.ts';
import { checkSolution } from '../../shared/validate.ts';
import type { PuzzleSource } from './ports.ts';

interface Racer extends PlayerInfo {
  boardIndex: number;
  score: number;
  solved: number;
  skipped: number;
  filled: number;
  connected: boolean;
  /** Server time this racer's current board became playable. */
  boardStartedAt: number;
  /** After a skip, no board is playable until this time. */
  lockedUntil: number;
  /** Server time of their last scoring solve; earlier wins ties. */
  lastScoreAt: number;
  /** Count of implausibly fast solves, for moderation. */
  flags: number;
}

export interface MatchInit {
  id: string;
  options: QueueOptions;
  ranked: boolean;
  practice?: boolean;
  lobbyCode: string | null;
  players: PlayerInfo[];
  now: number;
  puzzles: PuzzleSource;
  emit: (playerId: string, msg: ServerMessage) => void;
}

/**
 * A timed race. Everyone plays the same sequence of boards at their own
 * pace; solving a board scores points by size and immediately unlocks the
 * next one. The server holds the clock and validates every solve.
 */
export class Match {
  readonly id: string;
  readonly options: QueueOptions;
  readonly ranked: boolean;
  readonly practice: boolean;
  readonly lobbyCode: string | null;
  readonly startsAt: number;
  readonly endsAt: number;
  /** Tug of war: a points lead this big wins on the spot. */
  readonly tugTarget: number | null;
  finished = false;
  private endRequested = false;

  private readonly racers = new Map<string, Racer>();
  private readonly boards: Board[] = [];
  private readonly puzzles: PuzzleSource;
  private readonly emit: MatchInit['emit'];

  constructor(init: MatchInit) {
    this.id = init.id;
    this.options = init.options;
    this.ranked = init.ranked;
    this.practice = init.practice ?? false;
    this.lobbyCode = init.lobbyCode;
    this.puzzles = init.puzzles;
    this.emit = init.emit;
    this.startsAt = init.now + COUNTDOWN_MS;
    this.endsAt = this.startsAt + init.options.durationSec * 1000;
    this.tugTarget = init.options.mode === 'tug' ? tugTarget(init.options.sizeMode) : null;
    for (const p of init.players) {
      this.racers.set(p.id, {
        ...p,
        boardIndex: 0,
        score: 0,
        solved: 0,
        skipped: 0,
        filled: 0,
        connected: true,
        boardStartedAt: this.startsAt,
        lockedUntil: 0,
        lastScoreAt: Infinity,
        flags: 0,
      });
    }
  }

  get playerIds(): string[] {
    return [...this.racers.keys()];
  }

  has(playerId: string): boolean {
    return this.racers.has(playerId);
  }

  flagsOf(playerId: string): number {
    return this.racers.get(playerId)?.flags ?? 0;
  }

  /** The shared board sequence, generated lazily as the leader reaches it. */
  boardAt(index: number): Board {
    while (this.boards.length <= index) {
      this.boards.push(this.puzzles.next(boardSizeAt(this.options.sizeMode, this.boards.length)));
    }
    return this.boards[index];
  }

  start(now: number): void {
    for (const id of this.racers.keys()) this.sendSnapshot(id, now);
  }

  snapshot(playerId: string, now: number): MatchSnapshot {
    const r = this.racers.get(playerId)!;
    const boards: IndexedBoard[] = [r.boardIndex, r.boardIndex + 1].map((index) => ({
      index,
      board: this.boardAt(index),
    }));
    return {
      matchId: this.id,
      options: this.options,
      ranked: this.ranked,
      practice: this.practice,
      lobbyCode: this.lobbyCode,
      serverNow: now,
      startsAt: this.startsAt,
      endsAt: this.endsAt,
      racers: [...this.racers.values()].map(({ id, name, rating }) => ({ id, name, rating })),
      status: [...this.racers.values()].map((x) => this.status(x)),
      you: { boardIndex: r.boardIndex, score: r.score, lockedUntil: r.lockedUntil },
      boards,
      tugTarget: this.tugTarget,
      knockout: null,
    };
  }

  submit(playerId: string, boardIndex: number, paths: Paths, now: number): void {
    const r = this.racers.get(playerId);
    if (!r) return;
    const problem = this.checkTurn(r, boardIndex, now);
    if (problem) return this.reject(r, boardIndex, problem, now);

    const board = this.boardAt(boardIndex);
    if (!checkSolution(board, paths).ok) return this.reject(r, boardIndex, 'invalid', now);
    if (now - r.boardStartedAt < minSolveMs(board.size)) {
      r.flags++;
      return this.reject(r, boardIndex, 'too-fast', now);
    }

    r.score += pointsFor(board.size);
    r.solved++;
    r.lastScoreAt = now;
    this.advance(r, now, false);

    if (this.tugTarget !== null) {
      let best = 0;
      for (const other of this.racers.values()) if (other !== r) best = Math.max(best, other.score);
      // Rope pulled all the way: the match ends on the next tick.
      if (r.score - best >= this.tugTarget) this.requestEnd();
    }
  }

  skip(playerId: string, boardIndex: number, now: number): void {
    const r = this.racers.get(playerId);
    if (!r) return;
    const problem = this.checkTurn(r, boardIndex, now);
    if (problem) return this.reject(r, boardIndex, problem, now);
    r.skipped++;
    r.lockedUntil = now + SKIP_LOCKOUT_MS;
    this.advance(r, r.lockedUntil, true);
  }

  progress(playerId: string, boardIndex: number, filled: number): void {
    const r = this.racers.get(playerId);
    if (!r || this.finished || boardIndex !== r.boardIndex) return;
    const max = this.boardAt(boardIndex).size ** 2;
    r.filled = Math.max(0, Math.min(max, Math.floor(filled)));
    this.broadcastStatus(r);
  }

  setConnected(playerId: string, connected: boolean): void {
    const r = this.racers.get(playerId);
    if (!r || r.connected === connected) return;
    r.connected = connected;
    this.broadcastStatus(r);
  }

  /** Returns true exactly once, when the match ends. */
  tick(now: number): boolean {
    if (this.finished) return false;
    if (!this.endRequested && now < this.endsAt + SUBMIT_GRACE_MS) return false;
    this.finished = true;
    return true;
  }

  /** Ends the match on the next tick (practice runs can be stopped early). */
  requestEnd(): void {
    this.endRequested = true;
  }

  /** Final order: most points first, then whoever reached their score earliest. */
  standings(): Standing[] {
    const sorted = [...this.racers.values()].sort(
      (a, b) => b.score - a.score || a.lastScoreAt - b.lastScoreAt,
    );
    const out: Standing[] = [];
    sorted.forEach((r, i) => {
      const prev = sorted[i - 1];
      const tied = prev && prev.score === r.score && prev.lastScoreAt === r.lastScoreAt;
      out.push({
        id: r.id,
        name: r.name,
        score: r.score,
        solved: r.solved,
        skipped: r.skipped,
        place: tied ? out[i - 1].place : i + 1,
      });
    });
    return out;
  }

  private checkTurn(r: Racer, boardIndex: number, now: number): RejectReason | null {
    if (this.finished || this.endRequested) return 'time-up';
    if (now < this.startsAt) return 'not-live';
    if (now > this.endsAt + SUBMIT_GRACE_MS) return 'time-up';
    if (boardIndex !== r.boardIndex) return 'wrong-board';
    if (now < r.lockedUntil) return 'locked';
    return null;
  }

  private advance(r: Racer, nextStartsAt: number, skipped: boolean): void {
    const done = r.boardIndex;
    r.boardIndex++;
    r.filled = 0;
    r.boardStartedAt = nextStartsAt;
    this.emit(r.id, {
      type: 'match.ack',
      matchId: this.id,
      boardIndex: done,
      skipped,
      score: r.score,
      lockedUntil: r.lockedUntil,
    });
    // Keep the client one board ahead so the next board appears instantly.
    const index = r.boardIndex + 1;
    this.emit(r.id, { type: 'match.board', matchId: this.id, index, board: this.boardAt(index) });
    this.broadcastStatus(r);
  }

  private reject(r: Racer, boardIndex: number, reason: RejectReason, now: number): void {
    this.emit(r.id, { type: 'match.reject', matchId: this.id, boardIndex, reason });
    // Resync the client in case it advanced optimistically.
    if (!this.finished) this.sendSnapshot(r.id, now);
  }

  private sendSnapshot(playerId: string, now: number): void {
    this.emit(playerId, { type: 'match.state', ...this.snapshot(playerId, now) });
  }

  private status(r: Racer): RacerStatus {
    return {
      id: r.id,
      score: r.score,
      solved: r.solved,
      boardIndex: r.boardIndex,
      filled: r.filled,
      boardSize: this.boardAt(r.boardIndex).size,
      connected: r.connected,
    };
  }

  private broadcastStatus(r: Racer): void {
    const racer = this.status(r);
    for (const id of this.racers.keys()) {
      if (id !== r.id) this.emit(id, { type: 'match.racer', matchId: this.id, racer });
    }
  }
}
