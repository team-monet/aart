// approveOrDeprecateWorkflow — the "Approve / Deprecate" write action the
// dashboard's own form posts (AMENDMENTS.md A47: moved here from a
// dashboard-local implementation, closing the store-divergence bug class,
// root AMENDMENTS.md A43, for this write path too).
import type { Workflow } from "@aart/types";
import { describe, expect, it } from "vitest";
import { approveOrDeprecateWorkflow } from "./workflow-actions.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

function fixtureWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_ad",
    name: "n",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

async function withFixture(fn: (fx: TestFixture) => Promise<void>): Promise<void> {
  const fx = await createTestFixture();
  try {
    await fn(fx);
  } finally {
    await fx.cleanup();
  }
}

describe("approveOrDeprecateWorkflow", () => {
  it("action: approve recomputes approval from the current gates via the real computeApprovalState", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));

      const result = await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "approve", "governed");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.workflow.approval).toBe("approved"); // governed needs validate+humanReview, both passed
      expect((await fx.store.workflows.get("wf_ad", "1.0.0"))?.approval).toBe("approved");
    });
  });

  it("action: approve does NOT flip approval when required gates aren't satisfied", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" } }));

      const result = await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "approve", "governed");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.workflow.approval).toBe("draft"); // humanReview still pending
    });
  });

  it("action: deprecate sets 'deprecated' directly, independent of gate state (the one transition computeApprovalState never returns)", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } }));

      const result = await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "deprecate", "governed");

      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.workflow.approval).toBe("deprecated");
    });
  });

  it("not_found for an unknown workflow/version", async () => {
    await withFixture(async (fx) => {
      const result = await approveOrDeprecateWorkflow(fx.store, "no-such-workflow", "1.0.0", "approve", "governed");
      expect(result.kind).toBe("not_found");
    });
  });

  it("defaults trustMode to governed when omitted", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));
      const result = await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "approve");
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("unreachable");
      expect(result.workflow.approval).toBe("approved");
    });
  });
});

// V1 event log foundation (AMENDMENTS.md A61)
describe("approveOrDeprecateWorkflow — V1 event log writes", () => {
  it("emits workflow.approved when action: approve genuinely reaches 'approved'", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));
      await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "approve", "governed");
      const events = await fx.store.events.list();
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.approved", workflowId: "wf_ad", workflowVersion: "1.0.0" }));
    });
  });

  it("does NOT emit workflow.approved when action: approve doesn't reach 'approved' (gates unmet)", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" } }));
      await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "approve", "governed");
      const events = await fx.store.events.list();
      expect(events.some((e) => e.type === "workflow.approved")).toBe(false);
    });
  });

  it("emits workflow.deprecated for action: deprecate", async () => {
    await withFixture(async (fx) => {
      await fx.store.workflows.put(fixtureWorkflow({ approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } }));
      await approveOrDeprecateWorkflow(fx.store, "wf_ad", "1.0.0", "deprecate", "governed");
      const events = await fx.store.events.list();
      expect(events).toContainEqual(expect.objectContaining({ type: "workflow.deprecated", workflowId: "wf_ad", workflowVersion: "1.0.0" }));
    });
  });

  it("neither event fires for an unknown workflow/version (not_found, no write happens)", async () => {
    await withFixture(async (fx) => {
      await approveOrDeprecateWorkflow(fx.store, "no-such-workflow", "1.0.0", "approve", "governed");
      const events = await fx.store.events.list();
      expect(events).toEqual([]);
    });
  });
});
