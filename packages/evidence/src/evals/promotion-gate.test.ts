import { createFsStore, type AartStore } from "@aart/store";
import type { EvalRun } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureWorkflow } from "../test-support/fixtures.js";
import { applyEvalsGate, computeEvalsGateStatus } from "./promotion-gate.js";

function fixtureEvalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "er1",
    suiteId: "suite1",
    workflowId: "wf1",
    workflowVersion: "0.1.0",
    status: "completed",
    total: 10,
    passed: 10,
    failed: 0,
    score: 1,
    regressions: [],
    improvements: [],
    reportArtifact: "art1",
    ...overrides,
  };
}

describe("computeEvalsGateStatus (architecture §9.6) — pure threshold comparison", () => {
  it("passes when score meets the threshold exactly", () => {
    expect(computeEvalsGateStatus(fixtureEvalRun({ score: 0.95 }), 0.95)).toBe("passed");
  });

  it("passes when score exceeds the threshold", () => {
    expect(computeEvalsGateStatus(fixtureEvalRun({ score: 1.0 }), 0.95)).toBe("passed");
  });

  it("fails when score is below the threshold", () => {
    expect(computeEvalsGateStatus(fixtureEvalRun({ score: 0.8 }), 0.95)).toBe("failed");
  });
});

let root: string;
let store: AartStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-evidence-promotion-gate-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("applyEvalsGate — store-integrated write, tested against both above- and below-threshold cases (this session's DoD)", () => {
  it("writes gates.evals = 'passed' when the EvalRun.score meets promotion.requires[].evals.minScore", async () => {
    await store.workflows.put(fixtureWorkflow({ id: "wf_pass", version: "0.1.0" }));
    const updated = await applyEvalsGate(store, "wf_pass", "0.1.0", fixtureEvalRun({ score: 0.97 }), 0.95);
    expect(updated.gates.evals).toBe("passed");
    await expect(store.workflows.get("wf_pass", "0.1.0")).resolves.toMatchObject({ gates: { evals: "passed" } });
  });

  it("writes gates.evals = 'failed' when the EvalRun.score falls below minScore", async () => {
    await store.workflows.put(fixtureWorkflow({ id: "wf_fail", version: "0.1.0" }));
    const updated = await applyEvalsGate(store, "wf_fail", "0.1.0", fixtureEvalRun({ score: 0.5 }), 0.95);
    expect(updated.gates.evals).toBe("failed");
  });

  it("does not disturb the other 4 independent gates (spec §17.1: gates are independent, parallel facts)", async () => {
    await store.workflows.put(
      fixtureWorkflow({
        id: "wf_gates",
        version: "0.1.0",
        gates: { validate: "passed", readiness: "passed", evals: "pending", riskReview: "waived", humanReview: "pending" },
      }),
    );
    const updated = await applyEvalsGate(store, "wf_gates", "0.1.0", fixtureEvalRun({ score: 1 }), 0.9);
    expect(updated.gates).toEqual({ validate: "passed", readiness: "passed", evals: "passed", riskReview: "waived", humanReview: "pending" });
  });

  it("throws when the target workflow version does not exist", async () => {
    await expect(applyEvalsGate(store, "no-such-wf", "0.0.0", fixtureEvalRun(), 0.9)).rejects.toThrow(/no such workflow/);
  });
});
