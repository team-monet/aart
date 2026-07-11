// Shared test fixtures — not itself a `*.test.ts` file (vitest.config.ts's
// `include` only picks up `*.test.ts`), imported by every test file in this
// package that needs a store/clock/engine/logger to exercise real behavior
// against rather than a bare mock.
//
// Uses `createFsStore` (from `@aart/store`'s actual, properly-exported
// public surface) rather than this session's own SQLite adapter for these
// fixtures — see this task's final report for why: `@aart/store`'s
// `package.json` `exports` map currently only exposes `"."`, with no
// subpath for `adapters/sqlite/**`, so no OTHER package (including this
// one) can import the SQLite adapter without a one-line change to
// `packages/store/package.json` or `packages/store/src/index.ts` — both
// files OUTSIDE this session's declared carve-out
// (`packages/store/src/adapters/sqlite/**` only). The SQLite adapter's own
// correctness is already fully exercised by its own conformance suite +
// adapter-specific tests inside `packages/store` itself; this package's
// tests exist to prove ITS OWN logic (ticker/worker/triggers/bundle) is
// correct against the `AartStore` interface, which `createFsStore` — an
// already-available, fully-conformant implementation of that same
// interface — serves equally well for that purpose.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStore, type AartStore } from "@aart/store";
import type { Clock } from "./clock.js";
import { createFakeEngine, type EngineBoundary } from "./engine/boundary.js";
import { createServerLogger, type Logger } from "./logger.js";

export interface TestFixture {
  store: AartStore;
  engine: EngineBoundary;
  clock: Clock;
  logger: Logger;
  cleanup(): Promise<void>;
}

/** A controllable fake clock — `advance(ms)` moves time forward and fires any due `setTimeout` callbacks, without a real wall-clock wait. Used by ticker/worker tests that would otherwise need real sleeps to exercise interval-driven behavior. */
export function createFakeClock(startAt: string = "2026-07-10T00:00:00.000Z"): Clock & { advance(ms: number): void } {
  let current = new Date(startAt).getTime();
  const pending: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    setTimeout(fn, ms) {
      const entry = { at: current + ms, fn, cancelled: false };
      pending.push(entry);
      return { cancel: () => (entry.cancelled = true) };
    },
    advance(ms: number) {
      const target = current + ms;
      // Fire due callbacks in chronological order, allowing callbacks
      // scheduled BY a firing callback (e.g. the ticker's own re-schedule)
      // to also fire if they land within the advanced window.
      for (;;) {
        const due = pending
          .filter((e) => !e.cancelled && e.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending.splice(pending.indexOf(due), 1);
        current = due.at;
        due.fn();
      }
      current = target;
    },
  };
}

/**
 * Lets any in-flight async work (real fs I/O, promise chains) triggered by
 * a fake-clock-fired callback actually settle. `FakeClock.advance()` fires
 * due `setTimeout` callbacks SYNCHRONOUSLY (mirroring real `setTimeout`'s
 * own callback-is-synchronous contract), but a callback that internally
 * kicks off async work (e.g. `lease.ts`'s heartbeat calling
 * `store.jobQueue.renewLease`) doesn't block `advance()` on that work
 * completing — same as real `setTimeout` never blocks on a callback's own
 * returned (and ignored) promise. Tests that need to observe such a
 * callback's async side effects must flush afterward.
 */
export function flushAsync(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Advances `clock` in `stepMs` increments (flushing async work after each
 * step) until `condition()` is true or `maxSteps` is reached — for driving
 * fake-clock-scheduled polling loops (e.g. `gracefulShutdown`'s internal
 * `sleep` between drain checks) to their natural conclusion without a real
 * wall-clock wait.
 *
 * Always advances at least once, even if `condition()` is already true on
 * entry: a caller like `gracefulShutdown` may already be blocked awaiting
 * its own internal fake-clock-scheduled `sleep()` when the EXTERNAL
 * condition (e.g. `claimedRunIds.size === 0`) becomes true — that internal
 * sleep only resolves (letting the caller's loop re-check and exit) once
 * its own pending timer is advanced past. Checking-then-returning without
 * ever advancing would leave that internal sleep permanently pending.
 */
export async function driveClockUntil(clock: ReturnType<typeof createFakeClock>, condition: () => boolean, stepMs = 250, maxSteps = 100): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    clock.advance(stepMs);
    await flushAsync();
    if (condition()) return;
  }
}

/**
 * Polls `condition()` on a short REAL interval until it's true, or throws
 * once `timeoutMs` of real wall-clock time has elapsed. AMENDMENTS.md A45:
 * `flushAsync(ms=20)`'s single fixed sleep, used as a proxy for "has the
 * fake engine's fire-and-forget async work (a store write triggered from
 * inside a fake-clock-fired callback) landed yet", was observed to fail
 * `worker.test.ts`'s poison-flag test ~1/5 full-suite runs under CPU
 * contention — 20ms is sometimes not enough real time for that write to
 * land, and a LONGER fixed sleep is still just a probabilistically-safer
 * guess, not a fix (architecture the task explicitly called for: "poll-
 * until-condition with timeout, not a longer sleep"). This is that: the
 * real condition is checked directly, on a tight interval, so the test
 * proceeds the instant it's actually true and only ever fails when the
 * condition genuinely never becomes true within a generous timeout — not
 * when it becomes true one tick later than a fixed sleep guessed.
 */
export async function waitFor(condition: () => boolean | Promise<boolean>, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function createTestFixture(clock?: Clock): Promise<TestFixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-server-test-"));
  const store = createFsStore(root);
  const effectiveClock = clock ?? createFakeClock();
  const engine = createFakeEngine(store, effectiveClock);
  const logger = createServerLogger();
  return {
    store,
    engine,
    clock: effectiveClock,
    logger,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
