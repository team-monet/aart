import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, sampleWorkflowYaml } from "../test-utils.js";
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
