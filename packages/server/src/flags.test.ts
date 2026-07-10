// The flagged-run clear action (architecture §4.1/§4.7/§6.2/§13.3) — this
// session's DoD: "tested that clearing a reclaim-exhausted or
// poison-flagged run leaves status: 'failed' unchanged (clearing is not
// the same as re-running) and leaves the flag record itself in place with
// clearedBy/clearedAt populated, not removed."
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@aart/types";
import { clearRunFlag, listFlaggedRuns } from "./flags.js";
import { createFakeClock, createTestFixture, type TestFixture } from "./test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

function flaggedRun(kind: "reclaim_exhausted" | "poison", clock: ReturnType<typeof createFakeClock>): RunRecord {
  return {
    runId: `run_${kind}`,
    workflowId: "wf",
    workflowVersion: "1",
    status: "failed",
    approved: true,
    approvalMode: "dev",
    trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: clock.nowIso() },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: clock.nowIso() },
    startedAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
    schemaVersion: 1,
    flag: { kind, flaggedAt: clock.nowIso() },
  };
}

describe("clearRunFlag", () => {
  it("sets clearedBy/clearedAt on the EXISTING flag, without deleting it — status stays failed", async () => {
    const clock = createFakeClock("2026-07-10T00:00:00.000Z");
    fx = await createTestFixture(clock);
    await fx.store.runs.put(flaggedRun("poison", clock));

    const clearAt = "2026-07-10T01:00:00.000Z";
    const clearClock = createFakeClock(clearAt);
    const result = await clearRunFlag(fx.store, "run_poison", "jane@example.com", clearClock);
    expect(result.kind).toBe("cleared");
    if (result.kind === "cleared") {
      expect(result.run.status).toBe("failed"); // unchanged — clearing is not re-running
      expect(result.run.flag).toEqual({ kind: "poison", flaggedAt: clock.nowIso(), clearedBy: "jane@example.com", clearedAt: clearAt });
    }

    const persisted = await fx.store.runs.get("run_poison");
    expect(persisted?.status).toBe("failed");
    expect(persisted?.flag?.clearedBy).toBe("jane@example.com");
  });

  it("works identically for reclaim_exhausted", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(flaggedRun("reclaim_exhausted", clock));
    const result = await clearRunFlag(fx.store, "run_reclaim_exhausted", "ops@example.com", clock);
    expect(result.kind).toBe("cleared");
    const persisted = await fx.store.runs.get("run_reclaim_exhausted");
    expect(persisted?.status).toBe("failed");
    expect(persisted?.flag?.kind).toBe("reclaim_exhausted");
    expect(persisted?.flag?.clearedBy).toBe("ops@example.com");
  });

  it("not_found for an unknown run", async () => {
    fx = await createTestFixture();
    await expect(clearRunFlag(fx.store, "no-such-run", "jane", fx.clock)).resolves.toEqual({ kind: "not_found" });
  });

  it("no_flag when the run has no flag at all", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put({ ...flaggedRun("poison", clock), flag: undefined });
    await expect(clearRunFlag(fx.store, "run_poison", "jane", clock)).resolves.toEqual({ kind: "no_flag" });
  });

  it("no_flag when the flag was already cleared (idempotent — doesn't overwrite the original clearedBy)", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    const run = flaggedRun("poison", clock);
    run.flag = { ...run.flag!, clearedBy: "first-clearer", clearedAt: clock.nowIso() };
    await fx.store.runs.put(run);
    const result = await clearRunFlag(fx.store, "run_poison", "second-clearer", clock);
    expect(result.kind).toBe("no_flag");
    const persisted = await fx.store.runs.get("run_poison");
    expect(persisted?.flag?.clearedBy).toBe("first-clearer"); // untouched
  });
});

describe("listFlaggedRuns (architecture §13.3 dashboard view)", () => {
  it("lists only runs with an UNRESOLVED flag", async () => {
    const clock = createFakeClock();
    fx = await createTestFixture(clock);
    await fx.store.runs.put(flaggedRun("poison", clock));
    const cleared = flaggedRun("reclaim_exhausted", clock);
    cleared.runId = "run_already_cleared";
    cleared.flag = { ...cleared.flag!, clearedBy: "x", clearedAt: clock.nowIso() };
    await fx.store.runs.put(cleared);
    await fx.store.runs.put({ ...flaggedRun("poison", clock), runId: "run_ordinary_failed", flag: undefined });

    const flagged = await listFlaggedRuns(fx.store);
    expect(flagged.map((r) => r.runId)).toEqual(["run_poison"]);
  });
});
