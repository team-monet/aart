import { describe, expect, it } from "vitest";
import type { BlockPromotionFn, CreateEvalExampleFromCorrectionFn, CreateIssueForAgentFn, MarkNeedsReviewFn, RecordCorrectionFn, TriggerImprovementProposalFn, UnblockPromotionFn, UpdateRunOutputFn } from "../deps.js";
import { createTestFixture, makeCorrection, makeRun, makeWorkflow } from "../test-support/fixtures.js";
import {
  blockPromotionAction,
  createEvalExampleFromCorrectionAction,
  createIssueForAgentAction,
  markNeedsReviewAction,
  recordCorrectionAction,
  renderCorrectionQueuePage,
  triggerImprovementProposalAction,
  unblockPromotionAction,
  updateRunOutputAction,
} from "./corrections.js";

describe("renderCorrectionQueuePage", () => {
  it("renders a row per correction with outcome-action forms", () => {
    const html = renderCorrectionQueuePage([makeCorrection({ runId: "run-1", reason: "off by one" })]);
    expect(html).toContain("run-1");
    expect(html).toContain("off by one");
    expect(html).toContain("update-run-output");
    expect(html).toContain("create-eval-example");
    expect(html).toContain("create-issue");
  });
});

// Each outcome action is a one-line delegate — the same pattern flags.ts's
// clearFlagAction proves, applied to all 6 outcomes + 2 complements (S6
// seam E4). One representative spy-based proof per function is enough to
// establish the pattern; recordCorrection/updateRunOutput get one each too
// since they're the two most-used outcomes.

describe("action delegates — same-function-reference proofs (S6 seam E4)", () => {
  it("recordCorrectionAction delegates to the injected recordCorrection", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const spy: RecordCorrectionFn = async (s, input) => {
        calls.push(input);
        return { ...input, createdAt: "t" };
      };
      const input = { runId: "run-1", stepId: "s1", fieldPath: "outputs.x", observed: 1, corrected: 2, reason: "r", reviewer: "alice" };

      await recordCorrectionAction({ ...deps, recordCorrection: spy }, store, input);

      expect(calls).toEqual([input]);
    } finally {
      await cleanup();
    }
  });

  it("updateRunOutputAction delegates to the injected updateRunOutput", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const correction = makeCorrection();
      const fakeRun = makeRun();
      const spy: UpdateRunOutputFn = async (_s, c) => {
        calls.push(c);
        return fakeRun;
      };

      const result = await updateRunOutputAction({ ...deps, updateRunOutput: spy }, store, correction);

      expect(calls).toEqual([correction]);
      expect(result).toBe(fakeRun);
    } finally {
      await cleanup();
    }
  });

  it("createEvalExampleFromCorrectionAction delegates to the injected createEvalExampleFromCorrection", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const correction = makeCorrection();
      const spy: CreateEvalExampleFromCorrectionFn = async (_s, c, suiteId) => {
        calls.push({ c, suiteId });
        return { id: "ex1", suiteId, input: {}, expected: c.corrected };
      };

      await createEvalExampleFromCorrectionAction({ ...deps, createEvalExampleFromCorrection: spy }, store, correction, "suite-1");

      expect(calls).toEqual([{ c: correction, suiteId: "suite-1" }]);
    } finally {
      await cleanup();
    }
  });

  it("createIssueForAgentAction delegates to the injected createIssueForAgent", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const correction = makeCorrection();
      const spy: CreateIssueForAgentFn = async (_s, c) => {
        calls.push(c);
        return { workflowId: "wf", workflowVersion: "1.0.0", problemSummary: "x", failedEvalIds: [], corrections: [], constraints: [] };
      };

      await createIssueForAgentAction({ ...deps, createIssueForAgent: spy }, store, correction);

      expect(calls).toEqual([correction]);
    } finally {
      await cleanup();
    }
  });

  it("triggerImprovementProposalAction delegates to the injected triggerImprovementProposal", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const calls: unknown[] = [];
      const spy: TriggerImprovementProposalFn = async (_s, workflowId, workflowVersion) => {
        calls.push({ workflowId, workflowVersion });
        return { workflowId, workflowVersion, problemSummary: "x", failedEvalIds: [], corrections: [], constraints: [] };
      };

      await triggerImprovementProposalAction({ ...deps, triggerImprovementProposal: spy }, store, "wf-1", "1.0.0");

      expect(calls).toEqual([{ workflowId: "wf-1", workflowVersion: "1.0.0" }]);
    } finally {
      await cleanup();
    }
  });

  it("blockPromotionAction / unblockPromotionAction delegate to their injected functions", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));
      const blockCalls: unknown[] = [];
      const unblockCalls: unknown[] = [];
      const spyBlock: BlockPromotionFn = async (s, workflowId, version) => {
        blockCalls.push({ workflowId, version });
        return (await s.workflows.get(workflowId, version))!;
      };
      const spyUnblock: UnblockPromotionFn = async (s, workflowId, version) => {
        unblockCalls.push({ workflowId, version });
        return (await s.workflows.get(workflowId, version))!;
      };

      await blockPromotionAction({ ...deps, blockPromotion: spyBlock }, store, "wf-1", "1.0.0");
      await unblockPromotionAction({ ...deps, unblockPromotion: spyUnblock }, store, "wf-1", "1.0.0");

      expect(blockCalls).toEqual([{ workflowId: "wf-1", version: "1.0.0" }]);
      expect(unblockCalls).toEqual([{ workflowId: "wf-1", version: "1.0.0" }]);
    } finally {
      await cleanup();
    }
  });

  it("markNeedsReviewAction delegates to the injected markNeedsReview", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));
      const calls: unknown[] = [];
      const spy: MarkNeedsReviewFn = async (s, workflowId, version) => {
        calls.push({ workflowId, version });
        return (await s.workflows.get(workflowId, version))!;
      };

      await markNeedsReviewAction({ ...deps, markNeedsReview: spy }, store, "wf-1", "1.0.0");

      expect(calls).toEqual([{ workflowId: "wf-1", version: "1.0.0" }]);
    } finally {
      await cleanup();
    }
  });
});
