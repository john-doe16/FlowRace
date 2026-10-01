/** Board option a player queues for: one fixed size (5x5 to 11x11), or a ramp from 5x5 up to 9x9. */
export type SizeMode = 5 | 6 | 7 | 8 | 9 | 10 | 11 | 'ramp';
export const SIZE_MODES: readonly SizeMode[] = [5, 6, 7, 8, 9, 10, 11, 'ramp'];

export const DURATIONS = [60, 120, 180] as const;
export type DurationSec = (typeof DURATIONS)[number];

/**
 * race     - most points when the clock runs out.
 * tug      - 1v1 race that ends early once someone is far enough ahead.
 * knockout - lobbies only: one board per round, last to solve is out.
 */
export type GameMode = 'race' | 'tug' | 'knockout';
export const GAME_MODES: readonly GameMode[] = ['race', 'tug', 'knockout'];
/** Modes available in the ranked queue (knockout needs a lobby). */
export const QUEUE_MODES: readonly GameMode[] = ['race', 'tug'];

/** Silly modifiers for lobbies. Purely visual/input effects, applied on each client. */
export type Twist = 'fog' | 'memory' | 'spin' | 'mirror';
export const TWISTS: readonly Twist[] = ['fog', 'memory', 'spin', 'mirror'];

export interface QueueOptions {
  mode: GameMode;
  sizeMode: SizeMode;
  /** Match length; in knockout, the time limit for each round. */
  durationSec: DurationSec;
  twists: Twist[];
}

export const DEFAULT_OPTIONS: QueueOptions = { mode: 'race', sizeMode: 7, durationSec: 120, twists: [] };

export const COUNTDOWN_MS = 3000;
export const SKIP_LOCKOUT_MS = 5000;
/** Submissions are accepted this long after the clock hits zero, to absorb latency. */
export const SUBMIT_GRACE_MS = 150;
export const MAX_LOBBY_SIZE = 4;

/** Twist timings. */
export const MEMORY_REVEAL_MS = 3000;
export const SPIN_EVERY_MS = 8000;

/** Queue buckets are keyed by mode, size and time, so players only meet identical settings. */
export function optionsKey(o: Pick<QueueOptions, 'mode' | 'sizeMode' | 'durationSec'>): string {
  return `${o.mode}:${o.sizeMode}:${o.durationSec}`;
}

export function sizeModeLabel(mode: SizeMode): string {
  return mode === 'ramp' ? 'Ramp 5→9' : `${mode}×${mode}`;
}

export function durationLabel(sec: number): string {
  return `${sec / 60} min`;
}

export function modeLabel(mode: GameMode): string {
  return mode === 'race' ? 'Race' : mode === 'tug' ? 'Tug of war' : 'Knockout';
}

export function twistLabel(twist: Twist): string {
  return { fog: 'Fog', memory: 'Memory', spin: 'Spin', mirror: 'Mirror' }[twist];
}

/** Players needed to start a lobby race in this mode. */
export function playerRange(mode: GameMode): [number, number] {
  return mode === 'tug' ? [2, 2] : [2, MAX_LOBBY_SIZE];
}

/** Board size for the n-th board of a match (0-based). Ramp gets harder as you go. */
export function boardSizeAt(mode: SizeMode, index: number): number {
  if (mode !== 'ramp') return mode;
  if (index < 3) return 5;
  if (index < 6) return 6;
  if (index < 10) return 7;
  if (index < 15) return 8;
  return 9;
}

/** Bigger boards are worth more: 5x5 = 1 point up to 11x11 = 7 points. */
export function pointsFor(size: number): number {
  return size - 4;
}

/** Tug of war: the points lead that wins outright, about three boards' worth. */
export function tugTarget(sizeMode: SizeMode): number {
  return sizeMode === 'ramp' ? 8 : 3 * pointsFor(sizeMode);
}

/** Solves faster than this are rejected as implausible for a human. */
export function minSolveMs(size: number): number {
  return size * size * 28;
}

/**
 * Validates options from the wire or storage. Missing mode/twists fall back to
 * defaults (older clients and saved settings); twists are de-duplicated.
 */
export function parseOptions(x: unknown): QueueOptions | null {
  if (typeof x !== 'object' || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!(SIZE_MODES as readonly unknown[]).includes(o.sizeMode)) return null;
  if (!(DURATIONS as readonly unknown[]).includes(o.durationSec)) return null;
  const mode = o.mode === undefined ? 'race' : o.mode;
  if (!(GAME_MODES as readonly unknown[]).includes(mode)) return null;
  const twists = o.twists === undefined ? [] : o.twists;
  if (!Array.isArray(twists) || twists.length > TWISTS.length) return null;
  if (!twists.every((t) => (TWISTS as readonly unknown[]).includes(t))) return null;
  return {
    mode: mode as GameMode,
    sizeMode: o.sizeMode as SizeMode,
    durationSec: o.durationSec as DurationSec,
    twists: TWISTS.filter((t) => twists.includes(t)),
  };
}
