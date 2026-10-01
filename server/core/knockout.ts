import type { Board, Paths } from '../../shared/board.ts';
import type { MatchSnapshot, PlayerInfo, RacerStatus, RejectReason, Standing } from '../../shared/protocol.ts';
import { boardSizeAt, COUNTDOWN_MS, minSolveMs, SUBMIT_GRACE_MS, type QueueOptions } from '../../shared/rules.ts';
import { checkSolution } from '../../shared/validate.ts';
import type { MatchInit } from './match.ts';
import type { PuzzleSource } from './ports.ts';

interface KoRacer extends PlayerInfo {
  alive: boolean;
  /** Round this racer last solved, or -1. */
  solvedRound: number;
  roundsSolved: number;
  eliminatedRound: number | null;
  /** Cells filled this round; decides who goes out if the round times out. */
  filled: number;
  connected: boolean;
  flags: number;
}

/**
 * Knockout: every round, everyone still in plays the same single board.
 * When all but one have solved it, the last one is out. If the round's
 * clock runs out first, whoever filled the fewest cells is out (if that's
 * everyone left, they share the win). Last player standing wins.
 */
export class KnockoutMatch {
  readonly id: string;
  readonly options: QueueOptions;
  readonly ranked = false;
  readonly practice = false;
  readonly tugTarget = null;
  readonly lobbyCode: string | null;
  finished = false;

  private readonly racers = new Map<string, KoRacer>();
  private readonly boards: Board[] = [];
  private readonly puzzles: PuzzleSource;
  private readonly emit: MatchInit['emit'];
  private round = 0;
  private roundStartsAt: number;
  private roundEndsAt: number;
  private lastOut: string[] = [];
  private readonly eliminated: { id: string; round: number }[] = [];
  private endRequested = false;

  constructor(init: MatchInit) {
    this.id = init.id;
    this.options = init.options;
    this.lobbyCode = init.lobbyCode;
    this.puzzles = init.puzzles;
    this.emit = init.emit;
    this.roundStartsAt = init.now + COUNTDOWN_MS;
    this.roundEndsAt = this.roundStartsAt + this.roundMs;
    for (const p of init.players) {
      this.racers.set(p.id, {
        ...p,
        alive: true,
        solvedRound: -1,
        roundsSolved: 0,
        eliminatedRound: null,
        filled: 0,
        connected: true,
        flags: 0,
      });
    }
  }

  private get roundMs(): number {
    return this.options.durationSec * 1000;
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

  boardAt(index: number): Board {
    while (this.boards.length <= index) {
      this.boards.push(this.puzzles.next(boardSizeAt(this.options.sizeMode, this.boards.length)));
    }
    return this.boards[index];
  }

  start(now: number): void {
    this.sendSnapshots(now);
  }

  snapshot(playerId: string, now: number): MatchSnapshot {
    const r = this.racers.get(playerId)!;
    const playing = r.alive && r.solvedRound !== this.round;
    return {
      matchId: this.id,
      options: this.options,
      ranked: false,
      practice: false,
      lobbyCode: this.lobbyCode,
      serverNow: now,
      startsAt: this.roundStartsAt,
      endsAt: this.roundEndsAt,
      racers: [...this.racers.values()].map(({ id, name, rating }) => ({ id, name, rating })),
      status: [...this.racers.values()].map((x) => this.status(x)),
      you: { boardIndex: this.indexOf(r), score: r.roundsSolved, lockedUntil: 0 },
      // Only players still solving get the board; nobody gets the next one early.
      boards: playing ? [{ index: this.round, board: this.boardAt(this.round) }] : [],
      tugTarget: null,
      knockout: {
        round: this.round,
        alive: [...this.racers.values()].filter((x) => x.alive).map((x) => x.id),
        eliminated: [...this.eliminated],
        lastOut: [...this.lastOut],
      },
    };
  }

  submit(playerId: string, boardIndex: number, paths: Paths, now: number): void {
    const r = this.racers.get(playerId);
    if (!r) return;
    let problem: RejectReason | null = null;
    if (this.finished || this.endRequested) problem = 'time-up';
    else if (!r.alive || now < this.roundStartsAt) problem = 'not-live';
    else if (now > this.roundEndsAt + SUBMIT_GRACE_MS) problem = 'time-up';
    else if (boardIndex !== this.round || r.solvedRound === this.round) problem = 'wrong-board';
    if (problem) return this.reject(r, boardIndex, problem, now);

    const board = this.boardAt(this.round);
    if (!checkSolution(board, paths).ok) return this.reject(r, boardIndex, 'invalid', now);
    if (now - this.roundStartsAt < minSolveMs(board.size)) {
      r.flags++;
      return this.reject(r, boardIndex, 'too-fast', now);
    }

    r.solvedRound = this.round;
    r.roundsSolved++;
    this.emit(r.id, {
      type: 'match.ack',
      matchId: this.id,
      boardIndex: this.round,
      skipped: false,
      score: r.roundsSolved,
      lockedUntil: 0,
    });
    this.broadcastStatus(r);

    const stillSolving = this.alive().filter((x) => x.solvedRound !== this.round);
    if (stillSolving.length <= 1) this.endRound(now, stillSolving);
  }

  /** No skipping in knockout: a skip would be a free pass. */
  skip(playerId: string, boardIndex: number, now: number): void {
    const r = this.racers.get(playerId);
    if (r) this.reject(r, boardIndex, 'locked', now);
  }

  progress(playerId: string, boardIndex: number, filled: number): void {
    const r = this.racers.get(playerId);
    if (!r || this.finished || !r.alive || boardIndex !== this.round || r.solvedRound === this.round) return;
    const max = this.boardAt(this.round).size ** 2;
    r.filled = Math.max(0, Math.min(max, Math.floor(filled)));
    this.broadcastStatus(r);
  }

  setConnected(playerId: string, connected: boolean): void {
    const r = this.racers.get(playerId);
    if (!r || r.connected === connected) return;
    r.connected = connected;
    this.broadcastStatus(r);
  }

  tick(now: number): boolean {
    if (this.finished) return false;
    if (!this.endRequested && now > this.roundEndsAt + SUBMIT_GRACE_MS) {
      // Time's up: the least-filled of those still solving go out.
      const solving = this.alive().filter((x) => x.solvedRound !== this.round);
      const least = Math.min(...solving.map((x) => x.filled));
      this.endRound(now, solving.filter((x) => x.filled === least));
    }
    if (!this.endRequested) return false;
    this.finished = true;
    return true;
  }

  requestEnd(): void {
    this.endRequested = true;
  }

  /** Winner first, then by how late each player went out; same-round exits share a place. */
  standings(): Standing[] {
    const order = [...this.racers.values()].sort(
      (a, b) => (b.eliminatedRound ?? Infinity) - (a.eliminatedRound ?? Infinity) || b.roundsSolved - a.roundsSolved,
    );
    const out: Standing[] = [];
    order.forEach((r, i) => {
      const prev = order[i - 1];
      const tied = prev && prev.eliminatedRound === r.eliminatedRound;
      out.push({
        id: r.id,
        name: r.name,
        score: r.roundsSolved,
        solved: r.roundsSolved,
        skipped: 0,
        place: tied ? out[i - 1].place : i + 1,
      });
    });
    return out;
  }

  private alive(): KoRacer[] {
    return [...this.racers.values()].filter((x) => x.alive);
  }

  private endRound(now: number, out: KoRacer[]): void {
    const aliveBefore = this.alive();
    // If everyone left would go out together, they share the win instead.
    const everyone = out.length === aliveBefore.length;
    if (!everyone) {
      for (const r of out) {
        r.alive = false;
        r.eliminatedRound = this.round;
        this.eliminated.push({ id: r.id, round: this.round });
      }
      this.lastOut = out.map((r) => r.id);
    }
    if (everyone || this.alive().length <= 1) {
      this.endRequested = true;
      return;
    }
    this.round++;
    this.roundStartsAt = now + COUNTDOWN_MS;
    this.roundEndsAt = this.roundStartsAt + this.roundMs;
    for (const r of this.racers.values()) r.filled = 0;
    this.sendSnapshots(now);
  }

  private indexOf(r: KoRacer): number {
    return r.solvedRound === this.round ? this.round + 1 : this.round;
  }

  private status(r: KoRacer): RacerStatus {
    return {
      id: r.id,
      score: r.roundsSolved,
      solved: r.roundsSolved,
      boardIndex: this.indexOf(r),
      filled: r.filled,
      boardSize: this.boardAt(this.round).size,
      connected: r.connected,
    };
  }

  private reject(r: KoRacer, boardIndex: number, reason: RejectReason, now: number): void {
    this.emit(r.id, { type: 'match.reject', matchId: this.id, boardIndex, reason });
    if (!this.finished) this.emit(r.id, { type: 'match.state', ...this.snapshot(r.id, now) });
  }

  private sendSnapshots(now: number): void {
    for (const id of this.racers.keys()) this.emit(id, { type: 'match.state', ...this.snapshot(id, now) });
  }

  private broadcastStatus(r: KoRacer): void {
    const racer = this.status(r);
    for (const id of this.racers.keys()) {
      if (id !== r.id) this.emit(id, { type: 'match.racer', matchId: this.id, racer });
    }
  }
}
