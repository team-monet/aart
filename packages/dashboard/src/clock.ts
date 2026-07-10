// Clock seam — same shape/rationale as @aart/server's own clock.ts
// (observed in the S2 sibling worktree's SEAMS-adjacent source, not itself
// a published cross-session interface): every place this package needs
// "now" goes through this indirection so tests can inject a fixed/fake
// clock instead of depending on real wall-clock time — load-bearing for
// this package's own wait-AGE rendering (architecture §4.4.1) and
// flag/correction timestamps, which all need deterministic tests.
export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/** A controllable fake clock for tests — no timer-firing behavior needed here (unlike @aart/server's ticker-driving fake), just a settable "now". */
export function createFakeClock(startAt: string = "2026-07-10T00:00:00.000Z"): Clock & { set(iso: string): void } {
  let current = new Date(startAt);
  return {
    now: () => current,
    nowIso: () => current.toISOString(),
    set(iso: string) {
      current = new Date(iso);
    },
  };
}
