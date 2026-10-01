import { PROTOCOL_VERSION, type ClientMessage, type LobbyView, type MatchResult, type ServerMessage } from '../../shared/protocol.ts';
import { modeLabel, QUEUE_MODES, type QueueOptions } from '../../shared/rules.ts';
import { KnockoutMatch } from './knockout.ts';
import { Lobby, makeLobbyCode, normalizeLobbyCode } from './lobby.ts';
import { Match, type MatchInit } from './match.ts';

type AnyMatch = Match | KnockoutMatch;
import { Matchmaker } from './matchmaker.ts';
import { cleanName, parseClientMessage } from './parse.ts';
import type { Auth, Clock, ConnId, PlayerStore, PuzzleSource, Transport } from './ports.ts';
import { eloUpdate } from './rating.ts';

interface Session {
  id: string;
  name: string;
  rating: number;
  games: number;
  conn: ConnId | null;
  lobbyCode: string | null;
  matchId: string | null;
  lastSeen: number;
}

export interface GameServerDeps {
  transport: Transport;
  auth: Auth;
  store: PlayerStore;
  clock: Clock;
  puzzles: PuzzleSource;
  random?: () => number;
  makeId?: () => string;
  log?: (message: string) => void;
}

const STATS_INTERVAL_MS = 2000;
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * The whole game service, independent of transport and storage. A host
 * calls handleConnect / handleMessage / handleDisconnect as clients come
 * and go, and tick() on a short interval (~100ms) to drive the clock.
 */
export class GameServer {
  private readonly deps: GameServerDeps;
  private readonly random: () => number;
  private readonly makeId: () => string;
  private readonly log: (message: string) => void;

  /** Connection -> player id, or null until the client has said hello. */
  private readonly conns = new Map<ConnId, string | null>();
  private readonly sessions = new Map<string, Session>();
  private readonly matchmaker = new Matchmaker();
  private readonly lobbies = new Map<string, Lobby>();
  private readonly matches = new Map<string, AnyMatch>();
  private lastStatsAt = 0;

  constructor(deps: GameServerDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
    this.makeId = deps.makeId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  handleConnect(conn: ConnId): void {
    this.conns.set(conn, null);
  }

  async handleMessage(conn: ConnId, raw: unknown): Promise<void> {
    if (!this.conns.has(conn)) return;
    const msg = parseClientMessage(raw);
    if (!msg) return this.error(conn, 'bad-message', 'Malformed message.');
    if (msg.type === 'hello') return this.hello(conn, msg);

    const playerId = this.conns.get(conn);
    const session = playerId ? this.sessions.get(playerId) : undefined;
    if (!session) return this.error(conn, 'not-ready', 'Say hello first.');
    this.dispatch(session, msg);
  }

  handleDisconnect(conn: ConnId): void {
    const playerId = this.conns.get(conn);
    this.conns.delete(conn);
    const session = playerId ? this.sessions.get(playerId) : undefined;
    if (!session || session.conn !== conn) return;

    session.conn = null;
    session.lastSeen = this.deps.clock.now();
    this.matchmaker.leave(session.id);
    // During a race the clock keeps running; the player can reconnect and carry on.
    if (session.matchId) this.matches.get(session.matchId)?.setConnected(session.id, false);
    else if (session.lobbyCode) this.leaveLobby(session);
  }

  tick(): void {
    const now = this.deps.clock.now();

    for (const [a, b] of this.matchmaker.tick(now)) {
      const players = [this.sessions.get(a.playerId), this.sessions.get(b.playerId)];
      if (players.some((s) => !s)) continue;
      for (const s of players) this.send(s!, { type: 'queue.status', queued: null, since: null });
      this.createMatch(players as Session[], a.options, true, null);
    }

    for (const match of this.matches.values()) {
      if (match.tick(now)) this.finishMatch(match);
    }

    if (now - this.lastStatsAt >= STATS_INTERVAL_MS) {
      this.lastStatsAt = now;
      const msg: ServerMessage = { type: 'queue.stats', counts: this.matchmaker.counts() };
      for (const s of this.sessions.values()) if (!s.matchId) this.send(s, msg);
    }

    for (const s of this.sessions.values()) {
      if (!s.conn && !s.matchId && now - s.lastSeen > SESSION_TTL_MS) this.sessions.delete(s.id);
    }
  }

  private async hello(conn: ConnId, msg: Extract<ClientMessage, { type: 'hello' }>): Promise<void> {
    if (this.conns.get(conn)) return this.error(conn, 'already-hello', 'Already identified.');
    if (msg.v !== PROTOCOL_VERSION) {
      return this.error(conn, 'version', 'Client is out of date, please reload.');
    }
    const identity = await this.deps.auth.identify({ token: msg.token, name: cleanName(msg.name) });
    let session = this.sessions.get(identity.playerId);
    if (!session) {
      const profile = await this.deps.store.getProfile(identity.playerId);
      session = this.sessions.get(identity.playerId) ?? {
        id: identity.playerId,
        name: identity.name,
        rating: profile.rating,
        games: profile.games,
        conn: null,
        lobbyCode: null,
        matchId: null,
        lastSeen: this.deps.clock.now(),
      };
      this.sessions.set(session.id, session);
    }
    if (!this.conns.has(conn)) return; // Disconnected while we were loading.

    // One live connection per player: a new tab takes over from the old one.
    if (session.conn && session.conn !== conn) {
      this.error(session.conn, 'replaced', 'You connected from somewhere else.');
      this.conns.set(session.conn, null);
    }
    session.conn = conn;
    session.name = identity.name;
    this.conns.set(conn, session.id);
    // Keep the stored name current for the leaderboard.
    this.deps.store
      .saveProfile(session.id, { rating: session.rating, games: session.games, name: session.name })
      .catch((e) => this.log(`saveProfile failed: ${e}`));

    const now = this.deps.clock.now();
    this.send(session, {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      token: identity.token,
      player: { id: session.id, name: session.name, rating: session.rating, games: session.games },
      serverNow: now,
    });
    this.send(session, { type: 'queue.stats', counts: this.matchmaker.counts() });
    this.sendLobby(session);
    const match = session.matchId ? this.matches.get(session.matchId) : undefined;
    if (match) {
      match.setConnected(session.id, true);
      this.send(session, { type: 'match.state', ...match.snapshot(session.id, now) });
    }
  }

  private dispatch(s: Session, msg: ClientMessage): void {
    const now = this.deps.clock.now();
    const match = s.matchId ? this.matches.get(s.matchId) : undefined;

    switch (msg.type) {
      case 'queue.join': {
        if (s.matchId) return this.errorTo(s, 'busy', 'Finish your current match first.');
        if (s.lobbyCode) return this.errorTo(s, 'in-lobby', 'Leave your lobby to queue.');
        if (!QUEUE_MODES.includes(msg.options.mode)) {
          return this.errorTo(s, 'mode', `${modeLabel(msg.options.mode)} is for lobbies. Create one with friends.`);
        }
        // Twists are a lobby thing; ranked races are always played straight.
        const options: QueueOptions = { ...msg.options, twists: [] };
        this.matchmaker.join({ playerId: s.id, rating: s.rating, options, joinedAt: now });
        return this.send(s, { type: 'queue.status', queued: options, since: now });
      }
      case 'queue.leave':
        this.matchmaker.leave(s.id);
        return this.send(s, { type: 'queue.status', queued: null, since: null });

      case 'lobby.create': {
        if (s.matchId) return this.errorTo(s, 'busy', 'Finish your current match first.');
        this.leaveQueue(s);
        if (s.lobbyCode) this.leaveLobby(s);
        let code: string;
        do code = makeLobbyCode(this.random);
        while (this.lobbies.has(code));
        this.lobbies.set(code, new Lobby(code, s.id, msg.options));
        s.lobbyCode = code;
        return this.sendLobby(s);
      }
      case 'lobby.join': {
        if (s.matchId) return this.errorTo(s, 'busy', 'Finish your current match first.');
        const code = normalizeLobbyCode(msg.code);
        const lobby = this.lobbies.get(code);
        if (!lobby) return this.errorTo(s, 'no-lobby', `No lobby with code ${code || '(empty)'}.`);
        if (s.lobbyCode === code) return this.sendLobby(s);
        if (lobby.isFull) return this.errorTo(s, 'lobby-full', 'That lobby is full.');
        if (lobby.matchId) return this.errorTo(s, 'lobby-busy', 'That lobby is mid-race. Try again shortly.');
        this.leaveQueue(s);
        if (s.lobbyCode) this.leaveLobby(s);
        lobby.add(s.id);
        s.lobbyCode = code;
        return this.broadcastLobby(lobby);
      }
      case 'lobby.leave':
        if (s.lobbyCode && !s.matchId) this.leaveLobby(s);
        return;
      case 'lobby.options': {
        const lobby = this.lobbyOf(s);
        if (!lobby || lobby.matchId) return;
        if (lobby.hostId !== s.id) return this.errorTo(s, 'not-host', 'Only the host can change settings.');
        lobby.setOptions(msg.options);
        return this.broadcastLobby(lobby);
      }
      case 'lobby.ready': {
        const lobby = this.lobbyOf(s);
        if (!lobby || lobby.matchId) return;
        lobby.setReady(s.id, msg.ready);
        if (lobby.canStart()) {
          const players = [...lobby.members.keys()].map((id) => this.sessions.get(id)!);
          const match = this.createMatch(players, lobby.options, false, lobby.code);
          lobby.matchId = match.id;
        }
        return this.broadcastLobby(lobby);
      }

      case 'match.progress':
        return match?.progress(s.id, msg.boardIndex, msg.filled);
      case 'match.submit':
        if (!match) return;
        match.submit(s.id, msg.boardIndex, msg.paths, now);
        if (match.flagsOf(s.id) === 3) this.log(`player ${s.id} flagged for implausibly fast solves`);
        return;
      case 'match.skip':
        return match?.skip(s.id, msg.boardIndex, now);

      case 'practice.start': {
        if (s.matchId) return this.errorTo(s, 'busy', 'Finish your current match first.');
        if (s.lobbyCode) return this.errorTo(s, 'in-lobby', 'Leave your lobby to practice.');
        this.leaveQueue(s);
        // Practice is always a plain solo race.
        this.createMatch([s], { ...msg.options, mode: 'race', twists: [] }, false, null, true);
        return;
      }
      case 'practice.stop':
        if (!match?.practice) return;
        match.requestEnd();
        if (match.tick(now)) this.finishMatch(match);
        return;

      case 'leaderboard.get':
        void this.sendLeaderboard(s);
        return;
    }
  }

  private async sendLeaderboard(s: Session): Promise<void> {
    try {
      const [entries, rank] = await Promise.all([this.deps.store.leaderboard(20), this.deps.store.rankOf(s.id)]);
      this.send(s, { type: 'leaderboard', entries, you: { rank, rating: s.rating, games: s.games } });
    } catch (e) {
      this.log(`leaderboard failed: ${e}`);
    }
  }

  private createMatch(
    players: Session[],
    options: QueueOptions,
    ranked: boolean,
    lobbyCode: string | null,
    practice = false,
  ): AnyMatch {
    const init: MatchInit = {
      id: this.makeId(),
      options,
      ranked,
      practice,
      lobbyCode,
      players: players.map((p) => ({ id: p.id, name: p.name, rating: p.rating })),
      now: this.deps.clock.now(),
      puzzles: this.deps.puzzles,
      emit: (playerId, msg) => {
        const s = this.sessions.get(playerId);
        if (s) this.send(s, msg);
      },
    };
    const match = options.mode === 'knockout' ? new KnockoutMatch(init) : new Match(init);
    this.matches.set(match.id, match);
    for (const p of players) p.matchId = match.id;
    match.start(this.deps.clock.now());
    return match;
  }

  private finishMatch(match: AnyMatch): void {
    this.matches.delete(match.id);
    const standings = match.standings();
    const soleWinner = standings.length > 1 && standings[1].place !== 1;
    const winnerId = soleWinner ? standings[0].id : null;

    let ratings: MatchResult['ratings'] = null;
    const players = match.playerIds.map((id) => this.sessions.get(id));
    if (match.ranked && players.length === 2 && players[0] && players[1]) {
      const [a, b] = players as [Session, Session];
      const scoreA = winnerId === a.id ? 1 : winnerId === b.id ? 0 : 0.5;
      const [nextA, nextB] = eloUpdate(a, b, scoreA);
      ratings = {
        [a.id]: { before: a.rating, after: nextA },
        [b.id]: { before: b.rating, after: nextB },
      };
      a.rating = nextA;
      b.rating = nextB;
      for (const p of [a, b]) {
        p.games++;
        this.deps.store
          .saveProfile(p.id, { rating: p.rating, games: p.games, name: p.name })
          .catch((e) => this.log(`saveProfile failed: ${e}`));
      }
    }

    const result: MatchResult = {
      matchId: match.id,
      options: match.options,
      ranked: match.ranked,
      practice: match.practice,
      lobbyCode: match.lobbyCode,
      standings,
      winnerId,
      ratings,
    };
    for (const p of players) {
      if (!p) continue;
      p.matchId = null;
      this.send(p, { type: 'match.result', result });
    }
    this.deps.store.recordMatch(result).catch((e) => this.log(`recordMatch failed: ${e}`));

    const lobby = match.lobbyCode ? this.lobbies.get(match.lobbyCode) : undefined;
    if (lobby) {
      lobby.matchId = null;
      lobby.resetReady();
      // Anyone who dropped out during the race leaves the lobby now.
      for (const p of players) if (p && !p.conn) this.leaveLobby(p);
      if (this.lobbies.has(lobby.code)) this.broadcastLobby(lobby);
    }
  }

  private leaveQueue(s: Session): void {
    if (this.matchmaker.leave(s.id)) this.send(s, { type: 'queue.status', queued: null, since: null });
  }

  private leaveLobby(s: Session): void {
    const lobby = this.lobbyOf(s);
    s.lobbyCode = null;
    this.send(s, { type: 'lobby.state', lobby: null });
    if (!lobby) return;
    if (lobby.remove(s.id)) this.lobbies.delete(lobby.code);
    else this.broadcastLobby(lobby);
  }

  private lobbyOf(s: Session): Lobby | undefined {
    return s.lobbyCode ? this.lobbies.get(s.lobbyCode) : undefined;
  }

  private lobbyView(lobby: Lobby): LobbyView {
    return {
      code: lobby.code,
      hostId: lobby.hostId,
      options: lobby.options,
      matchId: lobby.matchId,
      members: [...lobby.members].map(([id, ready]) => {
        const s = this.sessions.get(id);
        return { id, name: s?.name ?? '?', rating: s?.rating ?? 0, ready, connected: !!s?.conn };
      }),
    };
  }

  private sendLobby(s: Session): void {
    const lobby = this.lobbyOf(s);
    this.send(s, { type: 'lobby.state', lobby: lobby ? this.lobbyView(lobby) : null });
  }

  private broadcastLobby(lobby: Lobby): void {
    const view = this.lobbyView(lobby);
    for (const id of lobby.members.keys()) {
      const s = this.sessions.get(id);
      if (s) this.send(s, { type: 'lobby.state', lobby: view });
    }
  }

  private send(s: Session, msg: ServerMessage): void {
    if (s.conn) this.deps.transport.send(s.conn, msg);
  }

  private error(conn: ConnId, code: string, message: string): void {
    this.deps.transport.send(conn, { type: 'error', code, message });
  }

  private errorTo(s: Session, code: string, message: string): void {
    this.send(s, { type: 'error', code, message });
  }
}
