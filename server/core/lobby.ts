import { MAX_LOBBY_SIZE, playerRange, type QueueOptions } from '../../shared/rules.ts';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeLobbyCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return code;
}

export function normalizeLobbyCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A private room for friends. Unranked; starts when everyone (2+) is ready. */
export class Lobby {
  readonly code: string;
  hostId: string;
  options: QueueOptions;
  matchId: string | null = null;
  /** Member ids in join order, with ready flags. */
  readonly members = new Map<string, boolean>();

  constructor(code: string, hostId: string, options: QueueOptions) {
    this.code = code;
    this.hostId = hostId;
    this.options = options;
    this.members.set(hostId, false);
  }

  get isFull(): boolean {
    return this.members.size >= MAX_LOBBY_SIZE;
  }

  add(playerId: string): void {
    this.members.set(playerId, false);
  }

  /** Removes a member and hands host to the next one. Returns true if the lobby is now empty. */
  remove(playerId: string): boolean {
    this.members.delete(playerId);
    if (this.hostId === playerId) {
      const next = this.members.keys().next();
      if (!next.done) this.hostId = next.value;
    }
    return this.members.size === 0;
  }

  setReady(playerId: string, ready: boolean): void {
    if (this.members.has(playerId)) this.members.set(playerId, ready);
  }

  /** Changing options un-readies everyone so nobody starts a race they didn't agree to. */
  setOptions(options: QueueOptions): void {
    this.options = options;
    this.resetReady();
  }

  resetReady(): void {
    for (const id of this.members.keys()) this.members.set(id, false);
  }

  canStart(): boolean {
    const [min, max] = playerRange(this.options.mode);
    if (this.matchId || this.members.size < min || this.members.size > max) return false;
    for (const ready of this.members.values()) if (!ready) return false;
    return true;
  }
}
