import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, Schedule } from "@aart/types";
import { createTicker } from "./ticker.js";
import { createFakeClock, createTestFixture, type TestFixture } from "../test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

function fixtureRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_x",
    workflowId: "wf",
    workflowVersion: "1",
    status: "waiting",
    approved: true,
    approvalMode: "dev",
    trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: "2026-07-10T00:00:00.000Z" },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: "2026-07-10T00:00:00.000Z" },
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

describe("scheduler ticker — timer-wait wake (architecture §4.4.3)", () => {
  it("resumes a due timer wait via the engine boundary's getDueWaits/resumeDirect seam", async () => {
    const clock = createFakeClock("2026-07-10T12:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRun());
    await fx.store.waits.put("run_x", "recheck_wait", { type: "timer", resumeAt: "2026-07-10T11:00:00.000Z", schemaVersion: 1 }, clock.nowIso());

    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger });
    const result = await ticker.tickOnce();
    expect(result.timerWaitsResumed).toBe(1);
    await expect(fx.store.runs.get("run_x")).resolves.toMatchObject({ status: "running" });
  });

  it("does NOT resume a timer wait that isn't due yet", async () => {
    const clock = createFakeClock("2026-07-10T12:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.runs.put(fixtureRun());
    await fx.store.waits.put("run_x", "recheck_wait", { type: "timer", resumeAt: "2026-07-10T23:00:00.000Z", schemaVersion: 1 }, clock.nowIso());

    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger });
    const result = await ticker.tickOnce();
    expect(result.timerWaitsResumed).toBe(0);
    await expect(fx.store.runs.get("run_x")).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("scheduler ticker — cron schedules (architecture §29/§6.1)", () => {
  it("fires a schedule once its cron time is reached during steady-state ticking", async () => {
    const clock = createFakeClock("2026-07-13T08:59:30.000Z"); // 2026-07-13 is a Monday
    fx = await createTestFixture(clock);
    await fx.store.workflows.put({
      id: "weekly-report",
      name: "n",
      version: "1",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });
    const schedule: Schedule = { id: "sched_1", workflowId: "weekly-report", workflowVersion: "1", cron: "0 9 * * 1", timezone: "UTC", missedRunPolicy: "fire_once", paused: false };
    await fx.store.schedules.put(schedule);

    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger }, { tickIntervalMs: 5000 });
    await ticker.tickOnce(); // startup reconciliation pass, nothing due yet (08:59:30)
    clock.advance(60_000); // now 09:00:30 — crossed 09:00:00
    const result = await ticker.tickOnce();
    expect(result.scheduleFires).toBe(1);
    const runs = await fx.store.runs.list({ workflowId: "weekly-report" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger.type).toBe("schedule");
  });

  it("does not double-fire the same occurrence across multiple ticks", async () => {
    const clock = createFakeClock("2026-07-13T09:00:30.000Z");
    fx = await createTestFixture(clock);
    await fx.store.workflows.put({ id: "wf-once", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
    await fx.store.schedules.put({ id: "sched_2", workflowId: "wf-once", workflowVersion: "1", cron: "0 9 * * 1", timezone: "UTC", missedRunPolicy: "fire_once", paused: false });

    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger });
    await ticker.tickOnce(); // startup reconciliation catches the 09:00:00 fire
    await ticker.tickOnce(); // a second tick shortly after must NOT re-fire it
    await ticker.tickOnce();
    const runs = await fx.store.runs.list({ workflowId: "wf-once" });
    expect(runs).toHaveLength(1);
  });

  it("a paused schedule never fires", async () => {
    const clock = createFakeClock("2026-07-13T09:00:30.000Z");
    fx = await createTestFixture(clock);
    await fx.store.workflows.put({ id: "wf-paused", name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
    await fx.store.schedules.put({ id: "sched_paused", workflowId: "wf-paused", workflowVersion: "1", cron: "0 9 * * 1", timezone: "UTC", missedRunPolicy: "fire_once", paused: true });

    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger });
    await ticker.tickOnce();
    await expect(fx.store.runs.list({ workflowId: "wf-paused" })).resolves.toHaveLength(0);
  });

  describe("missed-run policy (architecture §29/§6.1's three policies)", () => {
    async function setupMissedSchedule(policy: Schedule["missedRunPolicy"], clock: ReturnType<typeof createFakeClock>) {
      fx = await createTestFixture(clock);
      await fx.store.workflows.put({ id: `wf-${policy}`, name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
      // Cron fires every hour; server has been "down" long enough to miss
      // 3 occurrences (07:00, 08:00, 09:00) before this first tick at 09:05.
      await fx.store.schedules.put({ id: `sched-${policy}`, workflowId: `wf-${policy}`, workflowVersion: "1", cron: "0 * * * *", timezone: "UTC", missedRunPolicy: policy, paused: false });
    }

    it("skip — no missed occurrences are fired", async () => {
      const clock = createFakeClock("2026-07-13T09:05:00.000Z");
      await setupMissedSchedule("skip", clock);
      const ticker = createTicker({ store: fx!.store, engine: fx!.engine, clock, logger: fx!.logger }, { missedRunLookbackMs: 6 * 60 * 60 * 1000 });
      await ticker.tickOnce();
      await expect(fx!.store.runs.list({ workflowId: "wf-skip" })).resolves.toHaveLength(0);
    });

    it("fire_once — only the most recent missed occurrence fires", async () => {
      const clock = createFakeClock("2026-07-13T09:05:00.000Z");
      await setupMissedSchedule("fire_once", clock);
      const ticker = createTicker({ store: fx!.store, engine: fx!.engine, clock, logger: fx!.logger }, { missedRunLookbackMs: 6 * 60 * 60 * 1000 });
      await ticker.tickOnce();
      const runs = await fx!.store.runs.list({ workflowId: "wf-fire_once" });
      expect(runs).toHaveLength(1);
      expect((runs[0]?.trigger.payload as { firedAt: string }).firedAt).toBe("2026-07-13T09:00:00.000Z");
    });

    it("fire_all — every missed occurrence fires", async () => {
      const clock = createFakeClock("2026-07-13T09:05:00.000Z");
      await setupMissedSchedule("fire_all", clock);
      const ticker = createTicker({ store: fx!.store, engine: fx!.engine, clock, logger: fx!.logger }, { missedRunLookbackMs: 6 * 60 * 60 * 1000 });
      await ticker.tickOnce();
      const runs = await fx!.store.runs.list({ workflowId: "wf-fire_all" });
      // Lookback window is 6h from 09:05 -> 03:05, so hourly fires at
      // 04:00..09:00 = 6 occurrences.
      expect(runs.length).toBe(6);
    });
  });
});

describe("scheduler ticker — poll triggers (architecture §6.1)", () => {
  it("fires when the poll fetch succeeds", async () => {
    const clock = createFakeClock("2026-07-10T00:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.deployments.put({
      id: "dep_poll",
      workflowId: "wf-poll",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "poll", pollUrl: "https://api.example.com/rates", pollIntervalMs: 1000 },
      createdAt: clock.nowIso(),
    });
    const ticker = createTicker(
      { store: fx.store, engine: fx.engine, clock, logger: fx.logger },
      { fetchImpl: async () => ({ status: 200, json: async () => ({ rate: 0.5 }) }) },
    );
    const result = await ticker.tickOnce();
    expect(result.pollFires).toBe(1);
    const runs = await fx.store.runs.list({ workflowId: "wf-poll" });
    expect(runs).toHaveLength(1);
  });

  it("does not re-poll before its own interval elapses", async () => {
    const clock = createFakeClock("2026-07-10T00:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.deployments.put({
      id: "dep_poll2",
      workflowId: "wf-poll2",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "poll", pollUrl: "https://api.example.com/rates", pollIntervalMs: 60_000 },
      createdAt: clock.nowIso(),
    });
    let fetchCount = 0;
    const ticker = createTicker(
      { store: fx.store, engine: fx.engine, clock, logger: fx.logger },
      { fetchImpl: async () => { fetchCount += 1; return { status: 200, json: async () => ({ rate: 0.5 }) }; } },
    );
    await ticker.tickOnce();
    await ticker.tickOnce();
    expect(fetchCount).toBe(1);
  });
});

describe("scheduler ticker — reclaim sweep integration (architecture §4.7)", () => {
  it("a tick sweeps an expired claim and requeues it", async () => {
    const clock = createFakeClock("2026-07-10T00:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.jobQueue.enqueue("run_stale");
    await fx.store.jobQueue.setClaim("run_stale", "worker-dead", "2026-07-09T23:00:00.000Z"); // already expired
    const ticker = createTicker({ store: fx.store, engine: fx.engine, clock, logger: fx.logger });
    const result = await ticker.tickOnce();
    expect(result.reclaim.requeued).toContain("run_stale");
    await expect(fx.store.jobQueue.get("run_stale")).resolves.toMatchObject({ claimedBy: null });
  });
});
