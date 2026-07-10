// A tiny time indirection so the ticker/lease/reclaim/backpressure logic
// (all of it deadline-comparison-driven) is deterministically testable
// without real sleeps. `systemClock` is what every production entry point
// (startServer/startWorker) wires in by default; tests inject a fake.
export interface Clock {
  now(): Date;
  nowIso(): string;
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};
