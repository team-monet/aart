// Class 5 — Deployment validation (spec §18.5): "runtime target supports
// capabilities; secrets available; trigger config valid; durable wait
// store configured if waits used; artifact store configured; required
// approval/eval gates satisfied."
import type { Gates, Workflow, WorkflowStep } from "@aart/types";
import type { GateName } from "../gates.js";
import type { CapabilityClosureResult } from "../capability.js";
import type { ValidationFinding } from "./types.js";

// The 7 engine-level wait-type blocks (spec §15.3) — a workflow needs a
// configured durable wait store if it uses ANY of these, per §18.5's own
// conditional ("if waits used"). Fixed by spec, not something S3/a pack
// could redefine (block-level wrappers construct a WaitCondition and hand
// off to the engine — architecture §4.4 — these are the block ids that do).
const WAIT_BLOCK_IDS = new Set([
  "wait.for_signal",
  "wait.until",
  "wait.for_webhook",
  "wait.for_external_job",
  "wait.for_queue",
  "wait.manual",
  "human.approval",
]);

export interface TriggerConfigCheck {
  readonly type: string;
  readonly valid: boolean;
  readonly reason?: string;
}

export interface DeploymentValidationContext {
  /** Capabilities the target runtime/environment supports. */
  readonly targetCapabilities: readonly string[];
  /** Secret NAMEs resolvable in the target environment (bare names, not the `secrets:` prefix). */
  readonly availableSecrets: readonly string[];
  /** Trigger-config SHAPE validation is S2's own concern (trigger adapters) — this class only checks the boolean result it's handed. */
  readonly triggers?: readonly TriggerConfigCheck[];
  readonly waitStoreConfigured: boolean;
  readonly artifactStoreConfigured: boolean;
  readonly requiredGates: readonly GateName[];
}

export function validateDeployment(
  workflow: Pick<Workflow, "gates" | "execution">,
  closure: CapabilityClosureResult,
  context: DeploymentValidationContext,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  const targetCapSet = new Set(context.targetCapabilities);
  for (const capability of closure.capabilities) {
    if (capability.startsWith("secrets:")) continue; // checked separately below, more specifically, by name
    if (!targetCapSet.has(capability)) {
      findings.push({
        class: "deployment",
        path: "execution.steps",
        message: `Target environment does not support required capability "${capability}"`,
        severity: "error",
      });
    }
  }

  const availableSecretSet = new Set(context.availableSecrets);
  for (const capability of closure.capabilities) {
    if (!capability.startsWith("secrets:")) continue;
    const name = capability.slice("secrets:".length);
    if (!availableSecretSet.has(name)) {
      findings.push({
        class: "deployment",
        path: "execution.steps",
        message: `Secret "${name}" is referenced by this workflow but is not available in the target environment`,
        severity: "error",
      });
    }
  }

  for (const trigger of context.triggers ?? []) {
    if (!trigger.valid) {
      findings.push({
        class: "deployment",
        path: `triggers.${trigger.type}`,
        message: `Trigger config for "${trigger.type}" is invalid${trigger.reason ? `: ${trigger.reason}` : ""}`,
        severity: "error",
      });
    }
  }

  if (usesAnyWaitBlock(workflow.execution.steps) && !context.waitStoreConfigured) {
    findings.push({
      class: "deployment",
      path: "execution.steps",
      message: "This workflow contains a wait step but the target environment has no durable wait store configured",
      severity: "error",
    });
  }

  // Unconditional — spec §18.5 gates "durable wait store" on "if waits
  // used" but names "artifact store configured" with no such conditional,
  // since ANY run can produce trace/report/screenshot-on-failure artifacts
  // regardless of whether the workflow declares an explicit artifact.*
  // step.
  if (!context.artifactStoreConfigured) {
    findings.push({
      class: "deployment",
      path: "execution",
      message: "Target environment has no artifact store configured",
      severity: "error",
    });
  }

  for (const gate of context.requiredGates) {
    const status = (workflow.gates as Gates)[gate];
    if (status !== "passed" && status !== "waived") {
      findings.push({
        class: "deployment",
        path: `gates.${gate}`,
        message: `Required gate "${gate}" is not satisfied (current status: "${status}")`,
        severity: "error",
      });
    }
  }

  return findings;
}

function usesAnyWaitBlock(steps: readonly WorkflowStep[]): boolean {
  return steps.some((s) => WAIT_BLOCK_IDS.has(s.uses));
}
