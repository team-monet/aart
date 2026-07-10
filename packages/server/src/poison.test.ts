import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, Trigger } from "@aart/types";
import { correlationKeyFor, isOverBackpressureCeiling, isPoisonFlagged, shouldFlagPoison } from "./poison.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

function fixtureRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: overrides.runId ?? `run_${Math.random().toString(36).slice(2)}`,
    workflowId: "wf",
    workflowVersion: "1",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: { type: "manual", id: "trig_x", source: "cli", payload: null, receivedAt: new Date().toISOString() },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
    ...overrides,
  };
}

describe("correlationKeyFor (architecture §6.2)", () => {
  it("uses trigger.correlationId when present", () => {
    const trigger: Pick<Trigger, "id" | "correlationId"> = { id: "trig_1", correlationId: "case-42" };
    expect(correlationKeyFor("wf", trigger)).toBe("wf::case-42");
  });

  it("falls back to trigger.id when correlationId is absent", () => {
    const trigger: Pick<Trigger, "id" | "correlationId"> = { id: "trig_1", correlationId: undefined };
    expect(correlationKeyFor("wf", trigger)).toBe("wf::trig_1");
  });
});

describe("isPoisonFlagged (architecture §6.2)", () => {
  it("is undefined when no run for the key has ever been flagged", async () => {
    fx = await createTestFixture();
    const trigger: Pick<Trigger, "id" | "correlationId"> = { id: "trig_1", correlationId: "case-1" };
    await expect(isPoisonFlagged(fx.store, "wf", trigger)).resolves.toBeUndefined();
  });

  it("is defined once the MOST RECENT run for the key carries an uncleared poison flag", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    await fx.store.runs.put(fixtureRun({ runId: "run_old", trigger, startedAt: "2026-07-10T00:00:00.000Z", status: "failed" }));
    await fx.store.runs.put(fixtureRun({ runId: "run_new", trigger, startedAt: "2026-07-10T01:00:00.000Z", status: "failed", flag: { kind: "poison", flaggedAt: fx.clock.nowIso() } }));
    const flag = await isPoisonFlagged(fx.store, "wf", trigger);
    expect(flag?.kind).toBe("poison");
  });

  it("is undefined once the flag has been cleared (clearedAt set)", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    await fx.store.runs.put(fixtureRun({ runId: "run_cleared", trigger, status: "failed", flag: { kind: "poison", flaggedAt: fx.clock.nowIso(), clearedBy: "jane", clearedAt: fx.clock.nowIso() } }));
    await expect(isPoisonFlagged(fx.store, "wf", trigger)).resolves.toBeUndefined();
  });

  it("only considers the MOST RECENT run — an older flagged run doesn't poison a key whose latest run succeeded", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    await fx.store.runs.put(fixtureRun({ runId: "run_old_flagged", trigger, startedAt: "2026-07-10T00:00:00.000Z", status: "failed", flag: { kind: "poison", flaggedAt: fx.clock.nowIso() } }));
    await fx.store.runs.put(fixtureRun({ runId: "run_new_ok", trigger, startedAt: "2026-07-10T01:00:00.000Z", status: "completed" }));
    await expect(isPoisonFlagged(fx.store, "wf", trigger)).resolves.toBeUndefined();
  });
});

describe("shouldFlagPoison — N-consecutive-failures within a window (architecture §6.2)", () => {
  it("is false below the threshold", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    const now = new Date("2026-07-10T00:10:00.000Z");
    for (let i = 0; i < 2; i++) {
      await fx.store.runs.put(fixtureRun({ runId: `run_${i}`, trigger, status: "failed", startedAt: `2026-07-10T00:0${i}:00.000Z` }));
    }
    await expect(shouldFlagPoison(fx.store, "wf", trigger, { maxConsecutiveFailures: 3, now })).resolves.toBe(false);
  });

  it("is true once N consecutive failures accumulate", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    const now = new Date("2026-07-10T00:10:00.000Z");
    for (let i = 0; i < 3; i++) {
      await fx.store.runs.put(fixtureRun({ runId: `run_${i}`, trigger, status: "failed", startedAt: `2026-07-10T00:0${i}:00.000Z` }));
    }
    await expect(shouldFlagPoison(fx.store, "wf", trigger, { maxConsecutiveFailures: 3, now })).resolves.toBe(true);
  });

  it("a non-failed run breaks the consecutive streak", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    const now = new Date("2026-07-10T00:10:00.000Z");
    await fx.store.runs.put(fixtureRun({ runId: "run_0", trigger, status: "failed", startedAt: "2026-07-10T00:00:00.000Z" }));
    await fx.store.runs.put(fixtureRun({ runId: "run_1", trigger, status: "completed", startedAt: "2026-07-10T00:01:00.000Z" }));
    await fx.store.runs.put(fixtureRun({ runId: "run_2", trigger, status: "failed", startedAt: "2026-07-10T00:02:00.000Z" }));
    await fx.store.runs.put(fixtureRun({ runId: "run_3", trigger, status: "failed", startedAt: "2026-07-10T00:03:00.000Z" }));
    // Most recent two are failed, but the streak is broken by run_1 — total consecutive is 2, not 4.
    await expect(shouldFlagPoison(fx.store, "wf", trigger, { maxConsecutiveFailures: 3, now })).resolves.toBe(false);
    await expect(shouldFlagPoison(fx.store, "wf", trigger, { maxConsecutiveFailures: 2, now })).resolves.toBe(true);
  });

  it("a failure outside the time window doesn't count", async () => {
    fx = await createTestFixture();
    const trigger: Trigger = { type: "manual", id: "trig_1", source: "cli", payload: null, correlationId: "case-1", receivedAt: fx.clock.nowIso() };
    const now = new Date("2026-07-10T12:00:00.000Z");
    await fx.store.runs.put(fixtureRun({ runId: "run_old", trigger, status: "failed", startedAt: new Date(now.getTime() - 20 * 60_000).toISOString() }));
    await fx.store.runs.put(fixtureRun({ runId: "run_new", trigger, status: "failed", startedAt: now.toISOString() }));
    await expect(shouldFlagPoison(fx.store, "wf", trigger, { maxConsecutiveFailures: 2, windowMs: 10 * 60_000, now })).resolves.toBe(false);
  });
});

describe("isOverBackpressureCeiling (architecture §6.2)", () => {
  it("is false below the ceiling", async () => {
    fx = await createTestFixture();
    await fx.store.runs.put(fixtureRun({ status: "pending" }));
    await expect(isOverBackpressureCeiling(fx.store, 5)).resolves.toBe(false);
  });

  it("is true at/above the ceiling", async () => {
    fx = await createTestFixture();
    for (let i = 0; i < 5; i++) {
      await fx.store.runs.put(fixtureRun({ runId: `run_${i}`, status: "pending" }));
    }
    await expect(isOverBackpressureCeiling(fx.store, 5)).resolves.toBe(true);
  });

  it("only counts pending runs, not running/completed/failed", async () => {
    fx = await createTestFixture();
    for (let i = 0; i < 5; i++) {
      await fx.store.runs.put(fixtureRun({ runId: `run_${i}`, status: "completed" }));
    }
    await expect(isOverBackpressureCeiling(fx.store, 5)).resolves.toBe(false);
  });
});
