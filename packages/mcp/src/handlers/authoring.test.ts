import type { Workflow } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import { createRealAartContext } from "../context.js";
import type { TestContext } from "../test-utils.js";
import { cleanupTempRoot, createTestContext, makeTempRoot, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler, validateWorkflowHandler } from "./authoring.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

describe("registerWorkflowHandler (aart_register_block)", () => {
  it("compiles sugar YAML and saves it as a fresh draft version", async () => {
    tc = await createTestContext();
    const result = await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-register-1") });
    expect(result.ok).toBe(true);
    expect(result.workflowId).toBe("wf-register-1");
    expect(result.approval).toBe("draft");
  });

  it("persists the workflow so it's readable back from the store", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-register-2") });
    const stored = await tc.ctx.store.workflows.get("wf-register-2", "0.1.0");
    expect(stored).toBeDefined();
    expect(stored?.execution.steps).toHaveLength(2);
  });

  // V1 event log foundation (AMENDMENTS.md A61)
  it("emits a workflow.version_registered event carrying workflowId/workflowVersion", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-register-event") });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.version_registered", workflowId: "wf-register-event", workflowVersion: "0.1.0" }));
  });

  it("forces approval to draft even if the input tried to set something else", async () => {
    tc = await createTestContext();
    const result = await registerWorkflowHandler(tc.ctx, {
      workflow: { id: "wf-sneaky", name: "Sneaky", version: "0.1.0", steps: [{ id: "s1", uses: "flow.sleep", with: { ms: 1 } }], approval: "approved" },
    });
    expect(result.approval).toBe("draft");
  });

  it("fails with a clear error on invalid YAML", async () => {
    tc = await createTestContext();
    const result = await registerWorkflowHandler(tc.ctx, { workflow: "id: [unterminated" });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});

describe("validateWorkflowHandler (aart_validate)", () => {
  it("validates a well-formed draft as valid", async () => {
    tc = await createTestContext();
    const result = await validateWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-1") });
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("returns schema findings for a malformed draft (missing required fields)", async () => {
    tc = await createTestContext();
    const result = await validateWorkflowHandler(tc.ctx, { workflow: { id: "bad" } });
    expect(result.ok).toBe(false);
    expect(result.valid).toBe(false);
    expect((result.findings as unknown[]).length).toBeGreaterThan(0);
  });

  it("validates an already-registered workflow by workflowId+workflowVersion", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-2") });
    const result = await validateWorkflowHandler(tc.ctx, { workflowId: "wf-validate-2", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(true);
  });

  it("fails when the referenced workflowId/version doesn't exist", async () => {
    tc = await createTestContext();
    const result = await validateWorkflowHandler(tc.ctx, { workflowId: "nope", workflowVersion: "9.9.9" });
    expect(result.ok).toBe(false);
  });

  it("fails when neither workflow nor workflowId+workflowVersion is given", async () => {
    tc = await createTestContext();
    const result = await validateWorkflowHandler(tc.ctx, {});
    expect(result.ok).toBe(false);
  });
});

describe("validateWorkflowHandler — the validate GATE writer (S14 'gate write paths', A45's dead branch wired)", () => {
  it("a clean registered-version validation writes gates.validate = 'passed' and recomputes approval", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-gate-clean") });
    const result = await validateWorkflowHandler(tc.ctx, { workflowId: "wf-validate-gate-clean", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(true);
    expect((result.gates as { validate: string }).validate).toBe("passed");
    const stored = await tc.ctx.store.workflows.get("wf-validate-gate-clean", "0.1.0");
    expect(stored?.gates.validate).toBe("passed");
    // governed mode also requires humanReview, still pending -- approval
    // recomputation ran (this IS the shared gate-update path), it just
    // correctly stays "draft" since not every required gate passed yet.
    expect(stored?.approval).toBe("draft");
  });

  // V1 event log foundation (AMENDMENTS.md A61) — applyGateResult's shared
  // gate-write path emits BOTH workflow.validated (gate==="validate"
  // specifically) and workflow.gate_passed (status==="passed", any gate).
  it("emits BOTH workflow.validated and workflow.gate_passed events on a clean registered-version validation", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-gate-events") });
    await validateWorkflowHandler(tc.ctx, { workflowId: "wf-validate-gate-events", workflowVersion: "0.1.0" });
    const events = await tc.ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.validated", workflowId: "wf-validate-gate-events", workflowVersion: "0.1.0" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.gate_passed", workflowId: "wf-validate-gate-events", workflowVersion: "0.1.0" }));
    expect(events.some((e) => e.type === "workflow.gate_failed")).toBe(false);
  });

  it("a draft (in-memory, pre-registration) validation NEVER writes gates, even when it's valid — validate is a fact about a stored VERSION", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-gate-draft") });
    const draftResult = await validateWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-gate-draft-unrelated") });
    expect(draftResult.ok).toBe(true);
    expect(draftResult.gates).toBeUndefined();
    const stored = await tc.ctx.store.workflows.get("wf-validate-gate-draft", "0.1.0");
    expect(stored?.gates.validate).toBe("pending"); // completely untouched by the draft-shape call above
  });

  it("gates are per-VERSION: registering a new version starts its OWN gates.validate 'pending', independent of an earlier version already passed (negative test)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-per-version", "0.1.0") });
    await validateWorkflowHandler(tc.ctx, { workflowId: "wf-validate-per-version", workflowVersion: "0.1.0" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-validate-per-version", "0.2.0") });

    const v1 = await tc.ctx.store.workflows.get("wf-validate-per-version", "0.1.0");
    const v2 = await tc.ctx.store.workflows.get("wf-validate-per-version", "0.2.0");
    expect(v1?.gates.validate).toBe("passed");
    expect(v2?.gates.validate).toBe("pending");
  });
});

describe("validateWorkflowHandler — validate gate against REAL governance (distinct from the stub's schema-only check)", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await cleanupTempRoot(root);
    root = undefined;
  });

  it("a validation run WITH a real error-class finding (unknown block reference) writes gates.validate = 'failed' — negative test: an errored version cannot pass the validate gate", async () => {
    root = await makeTempRoot("aart-mcp-validate-gate-real-");
    const ctx = createRealAartContext({ root });
    const badWorkflow: Workflow = {
      id: "wf-validate-gate-error",
      name: "Bad reference",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "totally.not.a.real.block" }] },
      approval: "draft",
      gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    };
    await ctx.store.workflows.put(badWorkflow);

    const result = await validateWorkflowHandler(ctx, { workflowId: "wf-validate-gate-error", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(false);
    expect((result.findings as { class: string }[]).some((f) => f.class === "reference")).toBe(true);

    const stored = await ctx.store.workflows.get("wf-validate-gate-error", "0.1.0");
    expect(stored?.gates.validate).toBe("failed");

    // V1 event log foundation (AMENDMENTS.md A61) — the failed-outcome
    // sibling of the clean-pass test above: workflow.validated fires
    // regardless of outcome, workflow.gate_failed fires instead of
    // workflow.gate_passed.
    const events = await ctx.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.validated", workflowId: "wf-validate-gate-error", workflowVersion: "0.1.0" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "workflow.gate_failed", workflowId: "wf-validate-gate-error", workflowVersion: "0.1.0" }));
  });
});
