// computeApprovalState/computePromotionState (architecture §7.1, ADR-07) —
// this session's DoD: "same workflow version, promotion record promoted
// for staging's gate set while the production promotion record for the
// same version is not yet promoted under production's stricter set...
// this call never mutates the workflow version's own global approval
// field."
import { afterEach, describe, expect, it } from "vitest";
import type { Gates, Workflow } from "@aart/types";
import { computeApprovalState, computePromotionState, promoteWorkflowVersionToEnvironment, requiredGatesForEnvironment, REQUIRED_GATES_BY_TRUST_MODE } from "./promotion.js";
import { createFakeClock, createTestFixture, type TestFixture } from "./test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const partialGates: Gates = { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" };
const allPassedGates: Gates = { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" };

describe("computeApprovalState — pure, 2-arg (architecture §7.1)", () => {
  it("approved once every required gate is passed or waived", () => {
    expect(computeApprovalState(partialGates, REQUIRED_GATES_BY_TRUST_MODE.governed)).toBe("approved");
  });

  it("draft when a required gate hasn't passed", () => {
    expect(computeApprovalState(partialGates, REQUIRED_GATES_BY_TRUST_MODE.production)).toBe("draft");
  });

  it("a waived gate satisfies the requirement same as passed", () => {
    const gates: Gates = { ...partialGates, readiness: "waived" };
    expect(computeApprovalState(gates, ["validate", "readiness", "humanReview"])).toBe("approved");
  });
});

describe("computePromotionState — pure, 4-arg, never touches global approval (architecture §7.1/ADR-07)", () => {
  it("promoted requires BOTH global approval AND the environment's own required gates", () => {
    const clock = createFakeClock();
    const env = { id: "env_1", name: "staging", config: {} };
    const record = computePromotionState("approved", allPassedGates, REQUIRED_GATES_BY_TRUST_MODE.governed, env, clock);
    expect(record.promoted).toBe(true);
  });

  it("NOT promoted when global approval is still draft, even if gates would otherwise satisfy the environment", () => {
    const clock = createFakeClock();
    const env = { id: "env_1", name: "staging", config: {} };
    const record = computePromotionState("draft", allPassedGates, REQUIRED_GATES_BY_TRUST_MODE.governed, env, clock);
    expect(record.promoted).toBe(false);
  });

  it("is a pure function — has no store/side effects (same inputs, same output, called repeatedly)", () => {
    const clock = createFakeClock();
    const env = { id: "env_1", name: "prod", config: {} };
    const r1 = computePromotionState("approved", partialGates, REQUIRED_GATES_BY_TRUST_MODE.production, env, clock);
    const r2 = computePromotionState("approved", partialGates, REQUIRED_GATES_BY_TRUST_MODE.production, env, clock);
    expect(r1).toEqual(r2);
  });
});

describe("promoteWorkflowVersionToEnvironment — staging vs production divergence (this session's DoD)", () => {
  async function setUpWorkflow(fx: TestFixture, overrides: Partial<Workflow> = {}): Promise<void> {
    const workflow: Workflow = {
      id: "checkout-smoke",
      name: "n",
      version: "0.3.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved", // global approval already satisfied (validate+humanReview passed, governed-level)
      gates: partialGates, // validate=passed, humanReview=passed; readiness/evals/riskReview still pending
      ...overrides,
    };
    await fx.store.workflows.put(workflow);
  }

  it("same workflow version: promoted for staging (governed gate set) while NOT yet promoted for production (all-five gate set)", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx);
    await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
    await fx.store.environments.put({ id: "env_prod", name: "production", config: { trustMode: "production" } });

    const stagingResult = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
    expect(stagingResult.kind).toBe("promoted");

    const prodResult = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_prod" });
    expect(prodResult.kind).toBe("not_promoted");
  });

  it("never mutates the workflow version's own global approval field", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx);
    await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
    const before = await fx.store.workflows.get("checkout-smoke", "0.3.0");
    await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
    const after = await fx.store.workflows.get("checkout-smoke", "0.3.0");
    expect(after?.approval).toBe(before?.approval);
    expect(after?.gates).toEqual(before?.gates);
  });

  it("creates a Deployment record on a successful promotion", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx);
    await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
    const result = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
    expect(result.kind).toBe("promoted");
    if (result.kind === "promoted") {
      const deployments = await fx.store.deployments.list({ environmentId: "env_staging" });
      expect(deployments).toHaveLength(1);
      expect(deployments[0]?.workflowVersion).toBe("0.3.0");
    }
  });

  it("does not create a Deployment when not promoted", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx);
    await fx.store.environments.put({ id: "env_prod", name: "production", config: { trustMode: "production" } });
    await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_prod" });
    await expect(fx.store.deployments.list({ environmentId: "env_prod" })).resolves.toHaveLength(0);
  });

  it("refuses (defensively) while the workflow's promotion_blocked flag is set — see AMENDMENTS.md on which session owns the authoritative test", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx, { promotionBlocked: true });
    await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
    const result = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
    expect(result.kind).toBe("blocked_by_promotion_block");
    await expect(fx.store.deployments.list({ environmentId: "env_staging" })).resolves.toHaveLength(0);
  });

  it("workflow_not_found / environment_not_found are distinct, non-throwing outcomes", async () => {
    fx = await createTestFixture();
    await setUpWorkflow(fx);
    await expect(promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "no-such-wf", workflowVersion: "1", environmentId: "env_x" })).resolves.toEqual({ kind: "workflow_not_found" });
    await expect(promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "no-such-env" })).resolves.toEqual({ kind: "environment_not_found" });
  });
});

describe("requiredGatesForEnvironment", () => {
  it("defaults to governed when config.trustMode is absent", () => {
    expect(requiredGatesForEnvironment({ id: "e", name: "n", config: {} })).toEqual(REQUIRED_GATES_BY_TRUST_MODE.governed);
  });

  it("reads trustMode from the environment's config bag", () => {
    expect(requiredGatesForEnvironment({ id: "e", name: "n", config: { trustMode: "production" } })).toEqual(REQUIRED_GATES_BY_TRUST_MODE.production);
  });
});
