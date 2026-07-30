import { describe, expect, it } from "vitest";
import { createTestFixture, makeCorrection, makeEnvironment, makeEvalSuite, makeRun, makeWorkflow } from "./test-support/fixtures.js";

describe("clearRunFlag", () => {
  it("clears an existing, unresolved flag and preserves clearedBy/clearedAt on the flag record (not deleted)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      await store.runs.put(run);

      const result = await deps.clearRunFlag(store, run.runId, "alice");

      expect(result.kind).toBe("cleared");
      if (result.kind !== "cleared") throw new Error("unreachable");
      expect(result.run.flag).toEqual({ kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z", clearedBy: "alice", clearedAt: expect.any(String) });
      expect(result.run.status).toBe("failed"); // clearing never changes run status
    } finally {
      await cleanup();
    }
  });

  it("returns not_found for a nonexistent run", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const result = await deps.clearRunFlag(store, "no-such-run", "alice");
      expect(result).toEqual({ kind: "not_found" });
    } finally {
      await cleanup();
    }
  });

  it("returns no_flag for a run with no flag at all", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ status: "failed" });
      await store.runs.put(run);
      const result = await deps.clearRunFlag(store, run.runId, "alice");
      expect(result).toEqual({ kind: "no_flag" });
    } finally {
      await cleanup();
    }
  });

  it("returns no_flag for a run whose flag is already cleared", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ status: "failed", flag: { kind: "reclaim_exhausted", flaggedAt: "2026-07-09T00:00:00.000Z", clearedBy: "bob", clearedAt: "2026-07-09T01:00:00.000Z" } });
      await store.runs.put(run);
      const result = await deps.clearRunFlag(store, run.runId, "alice");
      expect(result).toEqual({ kind: "no_flag" });
    } finally {
      await cleanup();
    }
  });
});

describe("listFlaggedRuns", () => {
  it("lists only failed runs with an unresolved flag", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const flagged = makeRun({ runId: "r-flagged", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      const cleared = makeRun({ runId: "r-cleared", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z", clearedBy: "x", clearedAt: "2026-07-09T01:00:00.000Z" } });
      const unflagged = makeRun({ runId: "r-plain", status: "failed" });
      const completed = makeRun({ runId: "r-done", status: "completed" });
      await Promise.all([store.runs.put(flagged), store.runs.put(cleared), store.runs.put(unflagged), store.runs.put(completed)]);

      const result = await deps.listFlaggedRuns(store);

      expect(result.map((r) => r.runId)).toEqual(["r-flagged"]);
    } finally {
      await cleanup();
    }
  });
});

describe("triggerRun", () => {
  it("creates a pending RunRecord, persists it, and enqueues it onto the job queue", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-trigger", version: "2.0.0" });
      const run = await deps.triggerRun({ workflow, trigger: { type: "manual", id: "t1", source: "dashboard", payload: {}, receivedAt: "2026-07-10T00:00:00.000Z" }, inputs: { x: 1 } });

      expect(run.status).toBe("pending");
      expect(run.workflowId).toBe("wf-trigger");
      expect(run.workflowVersion).toBe("2.0.0");

      const persisted = await store.runs.get(run.runId);
      expect(persisted).toEqual(run);

      const claimable = await store.jobQueue.listClaimable(new Date(0).toISOString());
      expect(claimable.map((e) => e.runId)).toContain(run.runId);
    } finally {
      await cleanup();
    }
  });

  it("does not persist the Workflow itself (Seam 3's documented contract)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-not-persisted", version: "1.0.0" });
      await deps.triggerRun({ workflow, trigger: { type: "manual", id: "t1", source: "dashboard", payload: {}, receivedAt: "2026-07-10T00:00:00.000Z" }, inputs: {} });

      const stored = await store.workflows.get("wf-not-persisted", "1.0.0");
      expect(stored).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("computeApprovalState", () => {
  it("returns approved when every required gate is passed or waived", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const gates = { validate: "passed", readiness: "waived", evals: "pending", riskReview: "pending", humanReview: "pending" } as const;
      expect(deps.computeApprovalState(gates, ["validate", "readiness"])).toBe("approved");
    } finally {
      await cleanup();
    }
  });

  it("returns draft when a required gate is neither passed nor waived", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const gates = { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" } as const;
      expect(deps.computeApprovalState(gates, ["validate", "readiness"])).toBe("draft");
    } finally {
      await cleanup();
    }
  });
});

describe("evaluatePromotionForEnvironment", () => {
  const gates = { validate: "passed", readiness: "passed", evals: "pending", riskReview: "pending", humanReview: "pending" } as const;

  // S9 integration (reconciliation ledger item 2): deps.evaluatePromotionForEnvironment
  // is now @aart/governance's real function - its discriminated union uses
  // a `blocked: true|false` boolean flag, not this package's former local
  // `{kind: "blocked"|"evaluated"}` shape.
  it("refuses (blocked: true) when the workflow is promotionBlocked, regardless of gates", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const result = deps.evaluatePromotionForEnvironment({
        workflow: { promotionBlocked: true },
        globalApproval: "approved",
        gates,
        requiredGatesForEnvironment: ["validate"],
        environment: "prod",
      });
      expect(result).toEqual({ blocked: true, reason: "promotion_blocked", environment: "prod" });
    } finally {
      await cleanup();
    }
  });

  it("evaluates promoted:true when approved and all required gates are met", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const result = deps.evaluatePromotionForEnvironment({
        workflow: {},
        globalApproval: "approved",
        gates,
        requiredGatesForEnvironment: ["validate", "readiness"],
        environment: "prod",
      });
      expect(result).toEqual({ blocked: false, record: { environment: "prod", promoted: true, globalApproval: "approved", requiredGates: ["validate", "readiness"], unmetGates: [] } });
    } finally {
      await cleanup();
    }
  });

  it("evaluates promoted:false with the unmet gate named when a required gate isn't satisfied", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const result = deps.evaluatePromotionForEnvironment({
        workflow: {},
        globalApproval: "approved",
        gates,
        requiredGatesForEnvironment: ["validate", "evals"],
        environment: "prod",
      });
      expect(result).toEqual({ blocked: false, record: { environment: "prod", promoted: false, globalApproval: "approved", requiredGates: ["validate", "evals"], unmetGates: ["evals"] } });
    } finally {
      await cleanup();
    }
  });
});

describe("resumeApproval", () => {
  it("returns unmatched when there's no approval wait at (runId, stepId)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-noapproval", status: "waiting" });
      await store.runs.put(run);
      const result = await deps.resumeApproval("run-noapproval", "step1", { id: "task-1", status: "approved" });
      expect(result).toEqual({ kind: "unmatched", mechanism: "direct_lookup" });
    } finally {
      await cleanup();
    }
  });

  it("resumes on first decision: deletes the wait, records the dedupe key, and sets the run running", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-approve", status: "waiting", waits: [{ type: "approval", taskId: "task-1", schemaVersion: 1 }] });
      await store.runs.put(run);
      await store.waits.put("run-approve", "step1", { type: "approval", taskId: "task-1", schemaVersion: 1 }, "2026-07-10T00:00:00.000Z");

      const result = await deps.resumeApproval("run-approve", "step1", { id: "task-1", status: "approved", reviewer: "alice" });

      expect(result.kind).toBe("resumed");
      if (result.kind !== "resumed") throw new Error("unreachable");
      expect(result.run.status).toBe("running");
      expect(await store.waits.get("run-approve", "step1")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("returns duplicate on a second decision for the same (runId, stepId, taskId)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-dup", status: "waiting", waits: [{ type: "approval", taskId: "task-1", schemaVersion: 1 }] });
      await store.runs.put(run);
      await store.waits.put("run-dup", "step1", { type: "approval", taskId: "task-1", schemaVersion: 1 }, "2026-07-10T00:00:00.000Z");
      await deps.resumeApproval("run-dup", "step1", { id: "task-1", status: "approved" });

      // Re-arm a wait row to prove dedupe (not just wait-absence) is what blocks the second call.
      await store.waits.put("run-dup", "step1", { type: "approval", taskId: "task-1", schemaVersion: 1 }, "2026-07-10T00:00:00.000Z");
      const second = await deps.resumeApproval("run-dup", "step1", { id: "task-1", status: "approved" });

      expect(second).toEqual({ kind: "duplicate", mechanism: "direct_lookup" });
    } finally {
      await cleanup();
    }
  });
});

describe("decideApprovalTask", () => {
  it("sets status/reviewer/decision/decidedAt on the ApprovalTask", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.approvals.put({ id: "task-1", runId: "run-1", stepId: "step1", title: "Review", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });

      const updated = await deps.decideApprovalTask(store, "task-1", "approved", "alice", { note: "looks good" });

      expect(updated.status).toBe("approved");
      expect(updated.reviewer).toBe("alice");
      expect(updated.decision).toEqual({ note: "looks good" });
      expect(updated.decidedAt).toEqual(expect.any(String));
    } finally {
      await cleanup();
    }
  });

  it("throws for a nonexistent task id", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await expect(deps.decideApprovalTask(store, "nope", "approved", "alice")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});

describe("approveOrDeprecateWorkflow", () => {
  it("action=approve recomputes approval from gates via computeApprovalState", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-a", version: "1.0.0", approval: "draft", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
      await store.workflows.put(workflow);

      const updated = await deps.approveOrDeprecateWorkflow(store, "wf-a", "1.0.0", "approve", ["validate", "readiness"]);

      expect(updated.approval).toBe("approved");
      expect((await store.workflows.get("wf-a", "1.0.0"))?.approval).toBe("approved");
    } finally {
      await cleanup();
    }
  });

  it("action=deprecate force-sets deprecated regardless of gate state", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-d", version: "1.0.0", approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
      await store.workflows.put(workflow);

      const updated = await deps.approveOrDeprecateWorkflow(store, "wf-d", "1.0.0", "deprecate", []);

      expect(updated.approval).toBe("deprecated");
    } finally {
      await cleanup();
    }
  });
});

describe("promoteWorkflowVersionToEnvironment", () => {
  it("returns workflow_not_found for a missing workflow", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const env = makeEnvironment({ id: "env-1" });
      await store.environments.put(env);
      const result = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "nope", workflowVersion: "1.0.0", environmentId: "env-1" });
      expect(result).toEqual({ kind: "workflow_not_found" });
    } finally {
      await cleanup();
    }
  });

  it("returns environment_not_found for a missing environment", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-e", version: "1.0.0" });
      await store.workflows.put(workflow);
      const result = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "wf-e", workflowVersion: "1.0.0", environmentId: "nope" });
      expect(result).toEqual({ kind: "environment_not_found" });
    } finally {
      await cleanup();
    }
  });

  it("returns blocked_by_promotion_block when the workflow is promotion-blocked", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-b", version: "1.0.0", promotionBlocked: true, approval: "approved" });
      const env = makeEnvironment({ id: "env-b", config: { trustMode: "dev" } });
      await Promise.all([store.workflows.put(workflow), store.environments.put(env)]);
      const result = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "wf-b", workflowVersion: "1.0.0", environmentId: "env-b" });
      expect(result).toEqual({ kind: "blocked_by_promotion_block" });
    } finally {
      await cleanup();
    }
  });

  it("creates a Deployment on a successful promotion, and refreshes (not duplicates) it on a second promotion", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({
        id: "wf-p",
        version: "1.0.0",
        approval: "approved",
        gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
      });
      const env = makeEnvironment({ id: "env-p", config: { trustMode: "dev" } }); // dev trust mode -> no required gates
      await Promise.all([store.workflows.put(workflow), store.environments.put(env)]);

      const first = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "wf-p", workflowVersion: "1.0.0", environmentId: "env-p", triggerConfig: { a: 1 } });
      expect(first.kind).toBe("promoted");

      const afterFirst = await store.deployments.list({ environmentId: "env-p", workflowId: "wf-p" });
      expect(afterFirst).toHaveLength(1);

      const second = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "wf-p", workflowVersion: "1.0.0", environmentId: "env-p", triggerConfig: { a: 2 } });
      expect(second.kind).toBe("promoted");

      const afterSecond = await store.deployments.list({ environmentId: "env-p", workflowId: "wf-p" });
      expect(afterSecond).toHaveLength(1); // refreshed, not duplicated
      expect(afterSecond[0]?.triggerConfig).toEqual({ a: 2 });
      expect(afterSecond[0]?.id).toBe(afterFirst[0]?.id);
    } finally {
      await cleanup();
    }
  });

  it("returns not_promoted (without creating a Deployment) when a required gate for the environment isn't met", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({
        id: "wf-np",
        version: "1.0.0",
        approval: "approved",
        gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
      });
      const env = makeEnvironment({ id: "env-np", config: { trustMode: "production" } }); // requires readiness/evals/riskReview/humanReview too
      await Promise.all([store.workflows.put(workflow), store.environments.put(env)]);

      const result = await deps.promoteWorkflowVersionToEnvironment(store, { workflowId: "wf-np", workflowVersion: "1.0.0", environmentId: "env-np" });

      expect(result.kind).toBe("not_promoted");
      expect(await store.deployments.list({ environmentId: "env-np" })).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

describe("correction outcomes (S6 seam E4)", () => {
  it("recordCorrection persists a Correction with a createdAt timestamp", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const correction = await deps.recordCorrection(store, { runId: "run-1", stepId: "step1", fieldPath: "outputs.total", observed: 1, corrected: 2, reason: "off by one", reviewer: "alice" });
      expect(correction.createdAt).toEqual(expect.any(String));
      const listed = await store.corrections.list({ runId: "run-1" });
      expect(listed).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("updateRunOutput patches RunRecord.outputs for an outputs.<key> fieldPath", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({
        id: "wf-correction-output",
        outputs: [
          {
            name: "total",
            type: "number",
            required: true,
          },
          {
            name: "other",
            type: "string",
            required: true,
          },
        ],
        execution: {
          type: "workflow",
          steps: [{ id: "step1", uses: "http.get" }],
          outputMapping: {
            total: "{{ steps.step1.outputs.total }}",
            other: "{{ steps.step1.outputs.other }}",
          },
        },
      });
      const run = makeRun({
        runId: "run-out",
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        outputs: { total: 1, other: "x" },
        trace: [
          {
            seq: 0,
            stepId: "step1",
            block: "http.get",
            status: "completed",
            inputs: {},
            outputs: { total: 1, other: "x" },
            startedAt: "2026-07-10T00:00:00.000Z",
          },
        ],
        snapshot: {
          definitions: workflow,
          resolvedVersions: {},
          packHashes: {},
          capturedAt: "2026-07-10T00:00:00.000Z",
        },
      });
      await store.runs.put(run);
      const correction = makeCorrection({ runId: "run-out", fieldPath: "outputs.total", corrected: 42 });

      const updated = await deps.updateRunOutput(store, correction);

      expect(updated.outputs).toEqual({ total: 42, other: "x" });
      await expect(
        store.runs.getOperationalState(run.runId),
      ).resolves.toMatchObject({
        run: { outputs: { total: 42, other: "x" } },
      });
    } finally {
      await cleanup();
    }
  });

  it("updateRunOutput patches the named step's StepTrace.outputs and marks postHocCorrected for a non-outputs fieldPath", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({
        runId: "run-step",
        trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { count: 1 }, startedAt: "2026-07-10T00:00:00.000Z" }],
      });
      await store.runs.put(run);
      const correction = makeCorrection({ runId: "run-step", stepId: "step1", fieldPath: "outputs.count", corrected: 99 });

      const updated = await deps.updateRunOutput(store, correction);

      expect(updated.trace[0]?.outputs).toEqual({ count: 99 });
      expect(updated.trace[0]?.postHocCorrected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("createEvalExampleFromCorrection persists an EvalExample tagged with createdFromCorrection", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const correction = makeCorrection({ runId: "run-1", stepId: "step1", fieldPath: "outputs.total" });
      const example = await deps.createEvalExampleFromCorrection(store, correction, "suite-1");

      expect(example.suiteId).toBe("suite-1");
      expect(example.sourceRunId).toBe("run-1");
      expect(example.expected).toBe(correction.corrected);
      expect(example.createdFromCorrection).toEqual(expect.any(String));
      expect(await store.evals.listExamples("suite-1")).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("createIssueForAgent builds an ImprovementBrief scoped to the correction's run", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const run = makeRun({ runId: "run-issue", workflowId: "wf-issue", workflowVersion: "3.0.0" });
      await store.runs.put(run);
      const correction = makeCorrection({ runId: "run-issue" });

      const brief = await deps.createIssueForAgent(store, correction);

      expect(brief.workflowId).toBe("wf-issue");
      expect(brief.workflowVersion).toBe("3.0.0");
      expect(brief.corrections).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("triggerImprovementProposal aggregates every correction across every run of a workflow version", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const runA = makeRun({ runId: "run-a", workflowId: "wf-agg", workflowVersion: "1.0.0" });
      const runB = makeRun({ runId: "run-b", workflowId: "wf-agg", workflowVersion: "1.0.0" });
      const runOtherVersion = makeRun({ runId: "run-c", workflowId: "wf-agg", workflowVersion: "2.0.0" });
      await Promise.all([store.runs.put(runA), store.runs.put(runB), store.runs.put(runOtherVersion)]);
      await store.corrections.put(makeCorrection({ runId: "run-a" }));
      await store.corrections.put(makeCorrection({ runId: "run-b" }));
      await store.corrections.put(makeCorrection({ runId: "run-c" })); // different version — must not be included

      const brief = await deps.triggerImprovementProposal(store, "wf-agg", "1.0.0");

      expect(brief.corrections).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("blockPromotion / unblockPromotion / markNeedsReview / clearNeedsReview toggle the corresponding Workflow flags", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-flags", version: "1.0.0" }));

      const blocked = await deps.blockPromotion(store, "wf-flags", "1.0.0");
      expect(blocked.promotionBlocked).toBe(true);

      const unblocked = await deps.unblockPromotion(store, "wf-flags", "1.0.0");
      expect(unblocked.promotionBlocked).toBe(false);

      const needsReview = await deps.markNeedsReview(store, "wf-flags", "1.0.0");
      expect(needsReview.needsReview).toBe(true);

      const clearedReview = await deps.clearNeedsReview(store, "wf-flags", "1.0.0");
      expect(clearedReview.needsReview).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("report renderers (S6 seam E3)", () => {
  it("html/markdown/json/modelFacing/cliText/prComment all route through the injected redact function", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      let redactCalls = 0;
      const spyRedact: typeof deps.redact = (record, refs) => {
        redactCalls += 1;
        return deps.redact(record, refs);
      };
      const renderers = deps.createReportRenderers(spyRedact);
      const run = makeRun({
        runId: "run-report",
        status: "completed",
        outputs: { reusable: ["alpha", "beta"] },
        trace: [{ seq: 0, stepId: "s1", block: "http.get", status: "completed", inputs: {}, startedAt: "2026-07-10T00:00:00.000Z" }],
      });

      const html = renderers.html(run);
      expect(html).toContain("run-report");
      expect(html).toContain("alpha");
      expect(renderers.markdown(run)).toContain("run-report");
      expect(renderers.json(run)).toContain("run-report");
      expect(renderers.modelFacing(run).headline).toBe("passed");
      expect(renderers.cliText(run)).toContain("run-report");
      expect(renderers.prComment(run)).toContain("run-report");
      expect(redactCalls).toBe(6);
    } finally {
      await cleanup();
    }
  });

  it("html output escapes an HTML-unsafe step error rather than embedding it raw", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const renderers = deps.createReportRenderers(deps.redact);
      const run = makeRun({
        runId: "run-esc",
        status: "failed",
        trace: [{ seq: 0, stepId: "s1", block: "http.get", status: "failed", inputs: {}, error: '<script>alert("x")</script>', startedAt: "2026-07-10T00:00:00.000Z" }],
      });
      const html = renderers.html(run);
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      await cleanup();
    }
  });

  it("surfaces a workflow-level output failure in model-facing and HTML reports when every step completed", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const renderers = deps.createReportRenderers(deps.redact);
      const error = 'Workflow output validation failed: output "result" expected type "string" but received "object"';
      const run = makeRun({
        runId: "run-output-failure",
        status: "failed",
        error,
        trace: [{ seq: 0, stepId: "s1", block: "http.get", status: "completed", inputs: {}, startedAt: "2026-07-10T00:00:00.000Z" }],
      });

      expect(renderers.modelFacing(run).failures).toEqual([{ stepId: "$workflow", block: "workflow.outputMapping", error }]);
      const html = renderers.html(run);
      expect(html).toContain("Workflow output validation failed");
      expect(html).toContain("workflow.outputMapping");
    } finally {
      await cleanup();
    }
  });

  it("surfaces the terminal output failure even when the trace contains an older failed attempt", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const renderers = deps.createReportRenderers(deps.redact);
      const error = "Workflow output mapping failed: corrected result is missing";
      const run = makeRun({
        runId: "run-recovered-output-failure",
        status: "failed",
        error,
        trace: [{ seq: 0, stepId: "retry", block: "http.get", status: "failed", inputs: {}, error: "stale attempt", startedAt: "2026-07-10T00:00:00.000Z" }],
      });

      expect(renderers.modelFacing(run).failures.map((failure) => failure.stepId)).toEqual(["retry", "$workflow"]);
      expect(renderers.html(run)).toContain(error);
    } finally {
      await cleanup();
    }
  });
});

describe("scorer registry + runEvalSuite (S6 seam E2 / run-suite.ts)", () => {
  it("scores exact_match examples and aggregates pass/fail/score", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const registry = deps.createScorerRegistry();
      const suite = makeEvalSuite({ scorer: { id: "s1", kind: "exact_match" } }, [
        { id: "ex1", suiteId: "suite-x", input: 1, expected: 2 },
        { id: "ex2", suiteId: "suite-x", input: 3, expected: 3 },
      ]);

      const { evalRun, results } = await deps.runEvalSuite(suite, {
        execute: (input) => (input === 1 ? 2 : input), // ex1 "passes" by construction, ex2 passes by echo
        scorers: registry,
        workflowId: "wf-eval",
        workflowVersion: "1.0.0",
        reportArtifact: "artifact-1",
      });

      expect(evalRun.total).toBe(2);
      expect(evalRun.passed).toBe(2);
      expect(evalRun.failed).toBe(0);
      expect(evalRun.score).toBe(1);
      expect(results).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("records regressions for failed examples", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const registry = deps.createScorerRegistry();
      const suite = makeEvalSuite({ scorer: { id: "s1", kind: "exact_match" } }, [{ id: "ex-fail", suiteId: "suite-y", input: 1, expected: 999 }]);

      const { evalRun } = await deps.runEvalSuite(suite, {
        execute: (input) => input,
        scorers: registry,
        workflowId: "wf-eval",
        workflowVersion: "1.0.0",
        reportArtifact: "artifact-1",
      });

      expect(evalRun.failed).toBe(1);
      expect(evalRun.regressions).toEqual(["ex-fail"]);
    } finally {
      await cleanup();
    }
  });
});

describe("createEvalSuite", () => {
  it("persists a new EvalSuite and its examples", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const suite = await deps.createEvalSuite(store, { name: "My Suite", scorer: { id: "s1", kind: "exact_match" }, examples: [{ id: "ex1", suiteId: "placeholder", input: 1, expected: 1 }] });

      expect(suite.name).toBe("My Suite");
      expect(await store.evals.getSuite(suite.id)).toEqual(suite);
      expect(await store.evals.listExamples("placeholder")).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
