import { createFsStore, type AartStore } from "@aart/store";
import type { Correction } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureRunRecord, fixtureWorkflow } from "../test-support/fixtures.js";
import {
  blockPromotion,
  clearNeedsReview,
  createEvalExampleFromCorrection,
  createIssueForAgent,
  markNeedsReview,
  triggerImprovementProposal,
  unblockPromotion,
  updateRunOutput,
} from "./outcomes.js";

let root: string;
let store: AartStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-evidence-outcomes-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function fixtureCorrection(overrides: Partial<Correction> = {}): Correction {
  return {
    runId: "run_1",
    stepId: "extract",
    fieldPath: "outputs.nmi",
    observed: "6401234567",
    corrected: "6401234568",
    reason: "OCR misread final digit",
    reviewer: "jane@example.com",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("outcome 1/6 — updateRunOutput (spec §23.4 'update current run output')", () => {
  it("writes correction.corrected into the target StepTrace at fieldPath and flags postHocCorrected", async () => {
    const run = fixtureRunRecord({
      runId: "run_1",
      trace: [{ seq: 0, stepId: "extract", block: "llm.extract", status: "completed", inputs: {}, outputs: { nmi: "6401234567" }, startedAt: "t" }],
    });
    await store.runs.put(run);

    const updated = await updateRunOutput(store, fixtureCorrection());

    const trace = updated.trace.find((t) => t.stepId === "extract")!;
    expect(trace.outputs?.nmi).toBe("6401234568");
    expect(trace.postHocCorrected).toBe(true);
    await expect(store.runs.get("run_1")).resolves.toMatchObject({ trace: [{ outputs: { nmi: "6401234568" }, postHocCorrected: true }] });
  });

  it("throws when the run does not exist", async () => {
    await expect(updateRunOutput(store, fixtureCorrection({ runId: "no-such-run" }))).rejects.toThrow(/no such run/);
  });

  it("throws when the step does not exist on the run", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_2", trace: [] }));
    await expect(updateRunOutput(store, fixtureCorrection({ runId: "run_2" }))).rejects.toThrow(/no step/);
  });
});

describe("outcome 2/6 — createEvalExampleFromCorrection (spec §23.4 'create eval example')", () => {
  it("creates an EvalExample with createdFromCorrection set to the correction's composite key", async () => {
    const correction = fixtureCorrection();
    const example = await createEvalExampleFromCorrection(store, correction, "suite_1");
    expect(example.suiteId).toBe("suite_1");
    expect(example.sourceRunId).toBe("run_1");
    expect(example.expected).toBe("6401234568");
    expect(example.createdFromCorrection).toBe("run_1:extract:outputs.nmi");
    await expect(store.evals.listExamples("suite_1")).resolves.toEqual([example]);
  });
});

describe("outcome 3/6 — createIssueForAgent (spec §23.4 'create issue for agent') — scoped to ONE correction", () => {
  it("emits an ImprovementBrief-shaped notification for just this correction", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_1", workflowId: "energy.extract-bill", workflowVersion: "0.1.0" }));
    const brief = await createIssueForAgent(store, fixtureCorrection());
    expect(brief.workflowId).toBe("energy.extract-bill");
    expect(brief.workflowVersion).toBe("0.1.0");
    expect(brief.corrections).toEqual([{ summary: "OCR misread final digit", sourceRunId: "run_1", fieldPath: "outputs.nmi" }]);
    expect(brief.failedEvalIds).toEqual([]);
  });
});

describe("outcome 4/6 — triggerImprovementProposal (spec §23.4 'trigger workflow improvement proposal') — aggregates the WHOLE workflow version", () => {
  it("delegates to generateImprovementBrief's full aggregation (contrast with outcome 3's single-correction scope)", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_agg", workflowId: "energy.extract-bill", workflowVersion: "0.1.0" }));
    await store.corrections.put(fixtureCorrection({ runId: "run_agg", reason: "aggregated correction" }));

    const brief = await triggerImprovementProposal(store, "energy.extract-bill", "0.1.0", { constraints: ["preserve existing passing evals"] });
    expect(brief.workflowId).toBe("energy.extract-bill");
    expect(brief.corrections.map((c) => c.summary)).toContain("aggregated correction");
    expect(brief.constraints).toEqual(["preserve existing passing evals"]);
  });
});

describe("outcome 5/6 — blockPromotion (spec §23.4 'block promotion') — durably sets workflows.promotion_blocked (this session's DoD: 'block-promotion write, tested')", () => {
  it("sets promotionBlocked: true and persists it", async () => {
    const workflow = fixtureWorkflow({ id: "wf_block", version: "0.1.0", promotionBlocked: undefined });
    await store.workflows.put(workflow);

    const updated = await blockPromotion(store, "wf_block", "0.1.0");
    expect(updated.promotionBlocked).toBe(true);
    await expect(store.workflows.get("wf_block", "0.1.0")).resolves.toMatchObject({ promotionBlocked: true });
  });

  it("unblockPromotion (natural complement, not one of the 6 named outcomes) reverses it", async () => {
    await store.workflows.put(fixtureWorkflow({ id: "wf_unblock", version: "0.1.0" }));
    await blockPromotion(store, "wf_unblock", "0.1.0");
    const cleared = await unblockPromotion(store, "wf_unblock", "0.1.0");
    expect(cleared.promotionBlocked).toBe(false);
  });

  it("throws when the workflow version does not exist", async () => {
    await expect(blockPromotion(store, "no-such-wf", "0.0.0")).rejects.toThrow(/no such workflow/);
  });
});

describe("outcome 6/6 — markNeedsReview (spec §23.4 'mark workflow version as needs review')", () => {
  it("sets needsReview: true and persists it, distinct from promotionBlocked", async () => {
    const workflow = fixtureWorkflow({ id: "wf_review", version: "0.1.0" });
    await store.workflows.put(workflow);

    const updated = await markNeedsReview(store, "wf_review", "0.1.0");
    expect(updated.needsReview).toBe(true);
    expect(updated.promotionBlocked).toBeUndefined();
    await expect(store.workflows.get("wf_review", "0.1.0")).resolves.toMatchObject({ needsReview: true });
  });

  it("clearNeedsReview (natural complement) reverses it", async () => {
    await store.workflows.put(fixtureWorkflow({ id: "wf_review2", version: "0.1.0" }));
    await markNeedsReview(store, "wf_review2", "0.1.0");
    const cleared = await clearNeedsReview(store, "wf_review2", "0.1.0");
    expect(cleared.needsReview).toBe(false);
  });
});

describe("blockPromotion and markNeedsReview are two DISTINCT actions writing two DISTINCT fields, not one merged action (architecture §9.4, G4 fix)", () => {
  it("calling blockPromotion alone does not set needsReview, and vice versa", async () => {
    await store.workflows.put(fixtureWorkflow({ id: "wf_distinct", version: "0.1.0" }));
    const afterBlock = await blockPromotion(store, "wf_distinct", "0.1.0");
    expect(afterBlock.promotionBlocked).toBe(true);
    expect(afterBlock.needsReview).toBeUndefined();

    const afterReview = await markNeedsReview(store, "wf_distinct", "0.1.0");
    expect(afterReview.needsReview).toBe(true);
    expect(afterReview.promotionBlocked).toBe(true); // unaffected by the separate action
  });
});
