// Instant-runoff tally for ranked-choice polls. Each ballot lists options
// best-first and may leave options out. Each round counts every ballot for its
// highest-ranked surviving option; with no majority, the last-place options
// are dropped and their ballots move to their next choice.
export type RunoffResult = { winner: string | null; tied: string[]; rounds: Record<string, number>[] };

export function instantRunoff(options: string[], ballots: string[][]): RunoffResult {
  const alive = new Set(options);
  const rounds: Record<string, number>[] = [];
  while (alive.size) {
    const counts: Record<string, number> = Object.fromEntries([...alive].map((o) => [o, 0]));
    let active = 0;
    for (const b of ballots) {
      const top = b.find((o) => alive.has(o));
      if (top) { counts[top]++; active++; }
    }
    rounds.push(counts);
    if (!active) return { winner: null, tied: [], rounds };
    const entries = Object.entries(counts);
    const max = Math.max(...entries.map(([, n]) => n));
    const leaders = entries.filter(([, n]) => n === max).map(([o]) => o);
    if (max * 2 > active || alive.size === 1) return { winner: leaders[0], tied: [], rounds };
    const min = Math.min(...entries.map(([, n]) => n));
    const last = entries.filter(([, n]) => n === min).map(([o]) => o);
    if (last.length === alive.size) return { winner: null, tied: last, rounds };
    last.forEach((o) => alive.delete(o));
  }
  return { winner: null, tied: [], rounds };
}
