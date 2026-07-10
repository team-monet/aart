// Rollback as a first-class operation (architecture §0.2) — this session's
// DoD: "re-pointing a Deployment at a prior workflow version — tested as a
// first-class operation, including that an in-flight run at rollback time
// finishes on its own ExecutionSnapshot rather than being migrated or
// killed."
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, Workflow } from "@aart/types";
import { registerEnvironment, rollbackDeployment } from "./environments.js";
import { createTestFixture, type TestFixture } from "./test-helpers.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

function fixtureWorkflow(version: string): Workflow {
  return {
    id: "checkout-smoke",
    name: "n",
    version,
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  };
}

describe("registerEnvironment", () => {
  it("creates a new environment with the given trustMode folded into config", async () => {
    fx = await createTestFixture();
    const env = await registerEnvironment(fx.store, { name: "staging", trustMode: "governed" });
    expect(env.config.trustMode).toBe("governed");
    await expect(fx.store.environments.getByName("staging")).resolves.toEqual(env);
  });

  it("updating an existing environment preserves its id and merges config", async () => {
    fx = await createTestFixture();
    const first = await registerEnvironment(fx.store, { name: "staging", config: { region: "us-east-1" } });
    const second = await registerEnvironment(fx.store, { name: "staging", trustMode: "production" });
    expect(second.id).toBe(first.id);
    expect(second.config).toMatchObject({ region: "us-east-1", trustMode: "production" });
  });
});

describe("rollbackDeployment (architecture §0.2)", () => {
  it("re-points a Deployment at a prior workflow version", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("0.1.0"));
    await fx.store.workflows.put(fixtureWorkflow("0.2.0"));
    await fx.store.deployments.put({ id: "dep_1", workflowId: "checkout-smoke", workflowVersion: "0.2.0", environmentId: "env_1", triggerConfig: {}, createdAt: "2026-07-10T00:00:00.000Z" });

    const result = await rollbackDeployment(fx.store, "dep_1", "0.1.0");
    expect(result.kind).toBe("rolled_back");
    if (result.kind === "rolled_back") expect(result.deployment.workflowVersion).toBe("0.1.0");
    await expect(fx.store.deployments.get("dep_1")).resolves.toMatchObject({ workflowVersion: "0.1.0" });
  });

  it("does NOT touch an in-flight run's own snapshot/workflowVersion — it finishes on the version it started on (architecture §0.2's ExecutionSnapshot rationale)", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("0.1.0"));
    await fx.store.workflows.put(fixtureWorkflow("0.2.0"));
    await fx.store.deployments.put({ id: "dep_2", workflowId: "checkout-smoke", workflowVersion: "0.2.0", environmentId: "env_1", triggerConfig: {}, createdAt: "2026-07-10T00:00:00.000Z" });

    const inFlightRun: RunRecord = {
      runId: "run_in_flight",
      workflowId: "checkout-smoke",
      workflowVersion: "0.2.0", // started on 0.2.0, the version live at trigger time
      status: "running",
      approved: true,
      approvalMode: "governed",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: "2026-07-10T00:00:00.000Z" },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: { frozen: "0.2.0-tree" }, resolvedVersions: { "checkout-smoke": "0.2.0" }, packHashes: {}, capturedAt: "2026-07-10T00:00:00.000Z" },
      startedAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      schemaVersion: 1,
    };
    await fx.store.runs.put(inFlightRun);

    await rollbackDeployment(fx.store, "dep_2", "0.1.0");

    // The deployment now points at the rolled-back version...
    await expect(fx.store.deployments.get("dep_2")).resolves.toMatchObject({ workflowVersion: "0.1.0" });
    // ...but the in-flight run's own record — including its frozen
    // ExecutionSnapshot and the version it actually started on — is
    // completely untouched.
    const runAfterRollback = await fx.store.runs.get("run_in_flight");
    expect(runAfterRollback).toEqual(inFlightRun);
  });

  it("deployment_not_found for an unknown deployment id", async () => {
    fx = await createTestFixture();
    await expect(rollbackDeployment(fx.store, "no-such-deployment", "0.1.0")).resolves.toEqual({ kind: "deployment_not_found" });
  });

  it("target_version_not_found when the target workflow version was never registered", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("0.2.0"));
    await fx.store.deployments.put({ id: "dep_3", workflowId: "checkout-smoke", workflowVersion: "0.2.0", environmentId: "env_1", triggerConfig: {}, createdAt: "2026-07-10T00:00:00.000Z" });
    await expect(rollbackDeployment(fx.store, "dep_3", "9.9.9")).resolves.toEqual({ kind: "target_version_not_found" });
    // Deployment is left unchanged — no partial/invalid rollback.
    await expect(fx.store.deployments.get("dep_3")).resolves.toMatchObject({ workflowVersion: "0.2.0" });
  });
});
