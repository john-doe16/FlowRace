import { MAX_COLORS, MAX_SIZE } from '../../shared/board.ts';
import type { ClientMessage } from '../../shared/protocol.ts';
import { parseOptions } from '../../shared/rules.ts';

const isInt = (x: unknown): x is number => Number.isInteger(x);

function isPaths(x: unknown): boolean {
  if (!Array.isArray(x) || x.length > MAX_COLORS) return false;
  return x.every(
    (p) => Array.isArray(p) && p.length <= MAX_SIZE * MAX_SIZE && p.every(isInt),
  );
}

/** Validates the shape of an untrusted client message. Returns null if malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'hello':
      if (!isInt(m.v) || typeof m.name !== 'string') return null;
      if (m.token !== undefined && typeof m.token !== 'string') return null;
      return { type: 'hello', v: m.v, name: m.name, token: m.token as string | undefined };
    case 'queue.join':
    case 'lobby.create':
    case 'lobby.options':
    case 'practice.start': {
      const options = parseOptions(m.options);
      return options ? { type: m.type, options } : null;
    }
    case 'queue.leave':
    case 'lobby.leave':
    case 'practice.stop':
    case 'leaderboard.get':
      return { type: m.type };
    case 'lobby.join':
      return typeof m.code === 'string' ? { type: 'lobby.join', code: m.code } : null;
    case 'lobby.ready':
      return typeof m.ready === 'boolean' ? { type: 'lobby.ready', ready: m.ready } : null;
    case 'match.progress':
      return isInt(m.boardIndex) && isInt(m.filled)
        ? { type: 'match.progress', boardIndex: m.boardIndex, filled: m.filled }
        : null;
    case 'match.submit':
      return isInt(m.boardIndex) && isPaths(m.paths)
        ? { type: 'match.submit', boardIndex: m.boardIndex, paths: m.paths as number[][] }
        : null;
    case 'match.skip':
      return isInt(m.boardIndex) ? { type: 'match.skip', boardIndex: m.boardIndex } : null;
    default:
      return null;
  }
}

/** Trims and limits display names; falls back to a default. */
export function cleanName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  return cleaned || 'Player';
}
