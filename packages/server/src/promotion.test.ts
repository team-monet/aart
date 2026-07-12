// computeApprovalState/computePromotionState (architecture §7.1, ADR-07) —
// this session's DoD: "same workflow version, promotion record promoted
// for staging's gate set while the production promotion record for the
// same version is not yet promoted under production's stricter set...
// this call never mutates the workflow version's own global approval
// field."
import { afterEach, describe, expect, it } from "vitest";
import type { Gates, Workflow } from "@aart/types";
import { computeApprovalState, computePromotionState, promoteWorkflowVersionToEnvironment, requiredGatesForEnvironment, REQUIRED_GATES_BY_MODE } from "./promotion.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

const partialGates: Gates = { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" };
const allPassedGates: Gates = { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" };

describe("computeApprovalState — pure, 2-arg (architecture §7.1)", () => {
  it("approved once every required gate is passed or waived", () => {
    expect(computeApprovalState(partialGates, REQUIRED_GATES_BY_MODE.governed)).toBe("approved");
  });

  it("draft when a required gate hasn't passed", () => {
    expect(computeApprovalState(partialGates, REQUIRED_GATES_BY_MODE.production)).toBe("draft");
  });

  it("a waived gate satisfies the requirement same as passed", () => {
    const gates: Gates = { ...partialGates, readiness: "waived" };
    expect(computeApprovalState(gates, ["validate", "readiness", "humanReview"])).toBe("approved");
  });
});

// S9 integration (reconciliation ledger item 2): computePromotionState is
// now @aart/governance's real (4-arg, no clock) function, re-exported
// unchanged - `environment` is a plain string (an id, matching this
// package's own convention - see promotion.ts's header comment), not an
// Environment object; the output no longer carries environmentId/
// environmentName/computedAt (governance's shape has no timestamp - a
// PromotionRecord is always computed fresh, never persisted).
describe("computePromotionState — pure, 4-arg, never touches global approval (architecture §7.1/ADR-07)", () => {
  it("promoted requires BOTH global approval AND the environment's own required gates", () => {
    const record = computePromotionState("approved", allPassedGates, REQUIRED_GATES_BY_MODE.governed, "env_1");
    expect(record.promoted).toBe(true);
  });

  it("NOT promoted when global approval is still draft, even if gates would otherwise satisfy the environment", () => {
    const record = computePromotionState("draft", allPassedGates, REQUIRED_GATES_BY_MODE.governed, "env_1");
    expect(record.promoted).toBe(false);
  });

  it("is a pure function — has no store/side effects (same inputs, same output, called repeatedly)", () => {
    const r1 = computePromotionState("approved", partialGates, REQUIRED_GATES_BY_MODE.production, "env_1");
    const r2 = computePromotionState("approved", partialGates, REQUIRED_GATES_BY_MODE.production, "env_1");
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

  // D1 "remotes + push" (AMENDMENTS.md A56) — Deployment.promoted (the row's
  // own "is this active" flag) is DISTINCT from PromotionRecord.promoted
  // (governance's per-call eligibility computation, asserted on elsewhere in
  // this file) — a real local promotion must always stamp the former
  // explicitly true, on both the fresh-create AND merge-existing branches,
  // so deploymentToBinding (triggers/registry.ts) never treats a promoted
  // deployment as inactive.
  describe("Deployment.promoted is stamped true (AMENDMENTS.md A56)", () => {
    it("fresh-create branch: a brand-new Deployment is created with promoted:true", async () => {
      fx = await createTestFixture();
      await setUpWorkflow(fx);
      await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
      const result = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
      expect(result.kind).toBe("promoted");
      if (result.kind === "promoted") {
        expect(result.deployment.promoted).toBe(true);
        await expect(fx.store.deployments.get(result.deployment.id)).resolves.toMatchObject({ promoted: true });
      }
    });

    it("merge-existing branch: re-promoting an already-deployed workflow version keeps promoted:true", async () => {
      fx = await createTestFixture();
      await setUpWorkflow(fx);
      await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
      const first = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
      expect(first.kind).toBe("promoted");

      // A second promotion call against the SAME (workflow, environment) —
      // hits the `existing` branch (an existingForEnv match is found), not
      // the fresh-create one.
      const second = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging", triggerConfig: { type: "webhook", webhookPath: "/updated" } });
      expect(second.kind).toBe("promoted");
      if (second.kind === "promoted" && first.kind === "promoted") {
        expect(second.deployment.id).toBe(first.deployment.id); // same row, merged not duplicated
        expect(second.deployment.promoted).toBe(true);
        expect(second.deployment.triggerConfig).toEqual({ type: "webhook", webhookPath: "/updated" });
      }
    });

    it("even a Deployment previously hydrated with promoted:false (bundle-ingest evidence) flips to true once genuinely promoted", async () => {
      fx = await createTestFixture();
      await setUpWorkflow(fx);
      await fx.store.environments.put({ id: "env_staging", name: "staging", config: { trustMode: "governed" } });
      // Simulates D-2's ingest path having already recorded evidence
      // (promoted:false) for this exact (workflow, environment) pair before
      // a real promotion happens.
      await fx.store.deployments.put({
        id: "dep_pre_existing_unpromoted",
        workflowId: "checkout-smoke",
        workflowVersion: "0.3.0",
        environmentId: "env_staging",
        triggerConfig: {},
        createdAt: fx.clock.nowIso(),
        promoted: false,
      });

      const result = await promoteWorkflowVersionToEnvironment(fx.store, { workflowId: "checkout-smoke", workflowVersion: "0.3.0", environmentId: "env_staging" });
      expect(result.kind).toBe("promoted");
      if (result.kind === "promoted") {
        expect(result.deployment.id).toBe("dep_pre_existing_unpromoted"); // merged, not a new row
        expect(result.deployment.promoted).toBe(true);
      }
    });
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
    expect(requiredGatesForEnvironment({ id: "e", name: "n", config: {} })).toEqual(REQUIRED_GATES_BY_MODE.governed);
  });

  it("reads trustMode from the environment's config bag", () => {
    expect(requiredGatesForEnvironment({ id: "e", name: "n", config: { trustMode: "production" } })).toEqual(REQUIRED_GATES_BY_MODE.production);
  });
});
