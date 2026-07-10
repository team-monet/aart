import { describe, expect, it } from "vitest";
import type { ClearRunFlagFn } from "../deps.js";
import { createTestFixture, makeRun } from "../test-support/fixtures.js";
import { clearFlagAction, renderFlaggedRunsPage } from "./flags.js";

describe("clearFlagAction — same-function-reference proof (architecture §13.2/§13.3)", () => {
  it("calls the EXACT injected clearRunFlag reference — not a reimplementation, not just an equivalent-effect call", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-ref", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      await store.runs.put(run);

      const calls: Array<{ runId: string; clearedBy: string }> = [];
      // A distinguishable fake — proves clearFlagAction invokes THIS EXACT
      // reference (deps.clearRunFlag), not some parallel local write. At S9
      // merge, this same test (pointed at the real @aart/server import)
      // proves the real reference is wired in — the action's own code
      // never changes.
      const spyClearRunFlag: ClearRunFlagFn = async (s, runId, clearedBy) => {
        calls.push({ runId, clearedBy });
        return { kind: "cleared", run: { ...(await s.runs.get(runId))!, flag: { kind: "poison", flaggedAt: "x", clearedBy, clearedAt: "y" } } };
      };

      const result = await clearFlagAction({ ...deps, clearRunFlag: spyClearRunFlag }, store, "run-ref", "alice");

      expect(calls).toEqual([{ runId: "run-ref", clearedBy: "alice" }]);
      expect(result.kind).toBe("cleared");
    } finally {
      await cleanup();
    }
  });

  it("clearFlagAction's own body performs no store write itself — every persisted effect comes from the injected function", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-noop", status: "failed", flag: { kind: "reclaim_exhausted", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      await store.runs.put(run);

      let injectedFnCalled = false;
      const neverClears: ClearRunFlagFn = async () => {
        injectedFnCalled = true;
        return { kind: "no_flag" }; // deliberately does NOT clear
      };

      await clearFlagAction({ ...deps, clearRunFlag: neverClears }, store, "run-noop", "alice");

      expect(injectedFnCalled).toBe(true);
      const stillFlagged = await store.runs.get("run-noop");
      expect(stillFlagged?.flag?.clearedAt).toBeUndefined(); // clearFlagAction did NOT clear it itself
    } finally {
      await cleanup();
    }
  });

  it("end-to-end with the real stub clearRunFlag: clears and is reflected in listFlaggedRuns", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-e2e", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      await store.runs.put(run);

      await clearFlagAction(deps, store, "run-e2e", "alice");

      expect(await deps.listFlaggedRuns(store)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("renderFlaggedRunsPage", () => {
  it("renders a clear-flag form for each flagged run", () => {
    const html = renderFlaggedRunsPage([makeRun({ runId: "run-1", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } })]);
    expect(html).toContain("run-1");
    expect(html).toContain("poison");
    expect(html).toContain('action="/flagged-runs/run-1/clear"');
  });

  it("escapes run ids/flag kinds when rendering (no raw HTML injection from store data)", () => {
    const html = renderFlaggedRunsPage([makeRun({ runId: '<img src=x onerror=alert(1)>', status: "failed", flag: { kind: "poison", flaggedAt: "t" } })]);
    expect(html).not.toContain("<img src=x");
  });
});
