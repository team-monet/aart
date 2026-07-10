import type { Gates, Workflow, WorkflowStep } from "@aart/types";
import { describe, expect, it } from "vitest";
import type { CapabilityClosureResult } from "../capability.js";
import { validateDeployment, type DeploymentValidationContext } from "./deployment.js";

const ALL_PASSED: Gates = { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" };

function wf(steps: WorkflowStep[], gates: Gates = ALL_PASSED): Pick<Workflow, "gates" | "execution"> {
  return { gates, execution: { type: "workflow", steps } };
}

function baseContext(overrides: Partial<DeploymentValidationContext> = {}): DeploymentValidationContext {
  return {
    targetCapabilities: ["browser", "http"],
    availableSecrets: ["GITHUB_TOKEN"],
    waitStoreConfigured: true,
    artifactStoreConfigured: true,
    requiredGates: ["validate", "humanReview"],
    ...overrides,
  };
}

describe("validateDeployment — class 5 (spec §18.5)", () => {
  it("passes when everything the closure needs is satisfied", () => {
    const closure: CapabilityClosureResult = { capabilities: ["browser"], riskTier: "Medium", unresolved: [] };
    const findings = validateDeployment(wf([]), closure, baseContext());
    expect(findings).toEqual([]);
  });

  it("flags a capability the target environment doesn't support", () => {
    const closure: CapabilityClosureResult = { capabilities: ["command"], riskTier: "High", unresolved: [] };
    const findings = validateDeployment(wf([]), closure, baseContext());
    expect(findings.some((f) => f.message.includes("command") && f.severity === "error")).toBe(true);
  });

  it("flags a referenced secret not available in the target environment", () => {
    const closure: CapabilityClosureResult = { capabilities: ["secrets:STRIPE_KEY"], riskTier: "High", unresolved: [] };
    const findings = validateDeployment(wf([]), closure, baseContext());
    expect(findings.some((f) => f.message.includes("STRIPE_KEY"))).toBe(true);
  });

  it("does not flag an available secret", () => {
    const closure: CapabilityClosureResult = { capabilities: ["secrets:GITHUB_TOKEN"], riskTier: "High", unresolved: [] };
    const findings = validateDeployment(wf([]), closure, baseContext());
    expect(findings).toEqual([]);
  });

  it("flags an invalid trigger config", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    const findings = validateDeployment(
      wf([]),
      closure,
      baseContext({ triggers: [{ type: "webhook", valid: false, reason: "missing HMAC secret" }] }),
    );
    expect(findings.some((f) => f.message.includes("webhook") && f.message.includes("missing HMAC secret"))).toBe(true);
  });

  it("requires a durable wait store ONLY when the workflow uses a wait-type block", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    const withWait = wf([{ id: "w", uses: "human.approval" }]);
    const noWait = wf([{ id: "a", uses: "assert.contains" }]);

    const findingsWithWait = validateDeployment(withWait, closure, baseContext({ waitStoreConfigured: false }));
    expect(findingsWithWait.some((f) => f.message.includes("durable wait store"))).toBe(true);

    const findingsNoWait = validateDeployment(noWait, closure, baseContext({ waitStoreConfigured: false }));
    expect(findingsNoWait.some((f) => f.message.includes("durable wait store"))).toBe(false);
  });

  it("requires an artifact store UNCONDITIONALLY — spec §18.5 names it with no 'if used' qualifier unlike the wait store", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    const findings = validateDeployment(wf([{ id: "a", uses: "assert.contains" }]), closure, baseContext({ artifactStoreConfigured: false }));
    expect(findings.some((f) => f.message.includes("artifact store"))).toBe(true);
  });

  it("flags an unmet required gate", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    const gates: Gates = { ...ALL_PASSED, humanReview: "pending" };
    const findings = validateDeployment(wf([], gates), closure, baseContext({ requiredGates: ["validate", "humanReview"] }));
    expect(findings.some((f) => f.path === "gates.humanReview")).toBe(true);
  });

  it("treats a waived gate as satisfied", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    const gates: Gates = { ...ALL_PASSED, evals: "waived" };
    const findings = validateDeployment(wf([], gates), closure, baseContext({ requiredGates: ["evals"] }));
    expect(findings).toEqual([]);
  });
});
