// Environment + Deployment record helpers (architecture ADR-06/ADR-07) —
// rollback as a first-class operation (architecture §0.2).
import type { AartStore } from "@aart/store";
import type { Deployment, Environment } from "@aart/types";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { generateId } from "./ids.js";

export interface RegisterEnvironmentParams {
  name: string;
  trustMode?: "dev" | "governed" | "strict" | "production";
  config?: Record<string, unknown>;
  secretSource?: Record<string, unknown>;
}

export async function registerEnvironment(store: AartStore, params: RegisterEnvironmentParams): Promise<Environment> {
  const existing = await store.environments.getByName(params.name);
  const environment: Environment = {
    id: existing?.id ?? generateId("env"),
    name: params.name,
    config: { ...(existing?.config ?? {}), ...(params.config ?? {}), ...(params.trustMode ? { trustMode: params.trustMode } : {}) },
    secretSource: params.secretSource ?? existing?.secretSource,
  };
  await store.environments.put(environment);
  return environment;
}

export type RollbackResult = { kind: "rolled_back"; deployment: Deployment } | { kind: "deployment_not_found" } | { kind: "target_version_not_found" };

/**
 * architecture §0.2: "because workflow versions are immutable and a
 * Deployment is just a pointer... rollback is re-pointing that Deployment
 * record at a prior workflow version — no different in kind from promoting
 * a new version, just promoting an old one back." This function does
 * exactly that and nothing else — it deliberately does NOT touch any
 * existing `RunRecord`: "a run in progress keeps executing against the
 * ExecutionSnapshot/definition tree it captured at its own first-wait-or-
 * completion... so it finishes on the version it actually started on" is
 * true by construction as long as rollback never reaches into run state,
 * which it doesn't here.
 */
export async function rollbackDeployment(store: AartStore, deploymentId: string, targetWorkflowVersion: string, clock: Clock = systemClock): Promise<RollbackResult> {
  const deployment = await store.deployments.get(deploymentId);
  if (!deployment) return { kind: "deployment_not_found" };
  const targetWorkflow = await store.workflows.get(deployment.workflowId, targetWorkflowVersion);
  if (!targetWorkflow) return { kind: "target_version_not_found" };
  const updated: Deployment = { ...deployment, workflowVersion: targetWorkflowVersion, createdAt: clock.nowIso() };
  await store.deployments.put(updated);
  return { kind: "rolled_back", deployment: updated };
}
