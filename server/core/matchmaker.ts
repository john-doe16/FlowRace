import { optionsKey, type QueueOptions } from '../../shared/rules.ts';

export interface QueueEntry {
  playerId: string;
  rating: number;
  options: QueueOptions;
  joinedAt: number;
}

/** Allowed rating gap grows the longer someone waits: ±100 at first, up to ±800. */
export function ratingWindow(waitMs: number): number {
  return Math.min(100 + (waitMs / 1000) * 25, 800);
}

/** 1v1 ranked queue. Players are only paired with others who picked identical options. */
export class Matchmaker {
  private entries = new Map<string, QueueEntry>();

  join(entry: QueueEntry): void {
    this.entries.set(entry.playerId, entry);
  }

  leave(playerId: string): boolean {
    return this.entries.delete(playerId);
  }

  get(playerId: string): QueueEntry | undefined {
    return this.entries.get(playerId);
  }

  /** Players waiting per options key, for showing queue activity on the menu. */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of this.entries.values()) {
      const key = optionsKey(e.options);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** Pairs off compatible players and removes them from the queue. */
  tick(now: number): [QueueEntry, QueueEntry][] {
    const buckets = new Map<string, QueueEntry[]>();
    for (const e of this.entries.values()) {
      const key = optionsKey(e.options);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      bucket.push(e);
    }

    const pairs: [QueueEntry, QueueEntry][] = [];
    for (const bucket of buckets.values()) {
      // Longest-waiting players get first pick.
      bucket.sort((a, b) => a.joinedAt - b.joinedAt);
      const taken = new Set<string>();
      for (const a of bucket) {
        if (taken.has(a.playerId)) continue;
        let best: QueueEntry | null = null;
        let bestGap = Infinity;
        for (const b of bucket) {
          if (b === a || taken.has(b.playerId)) continue;
          const gap = Math.abs(a.rating - b.rating);
          const allowed = Math.max(ratingWindow(now - a.joinedAt), ratingWindow(now - b.joinedAt));
          if (gap <= allowed && gap < bestGap) {
            best = b;
            bestGap = gap;
          }
        }
        if (best) {
          taken.add(a.playerId);
          taken.add(best.playerId);
          pairs.push([a, best]);
        }
      }
    }
    for (const [a, b] of pairs) {
      this.entries.delete(a.playerId);
      this.entries.delete(b.playerId);
    }
    return pairs;
  }
}
