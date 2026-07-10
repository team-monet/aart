// A runtime smoke test over the package's full public surface (index.ts) —
// the build already proves every export path resolves at the TYPE level;
// this proves the barrel file itself doesn't throw at import time (e.g. a
// resolved export-collision silently picking the wrong binding) and that
// every named export is actually the kind of thing its name promises.
import { describe, expect, it } from "vitest";
import * as governance from "./index.js";

describe("@aart/governance public surface (index.ts)", () => {
  it("exports every named function this session's DoD calls out by name", () => {
    const expectedFunctions = [
      "computeApprovalState",
      "computePromotionState",
      "evaluatePromotionForEnvironment",
      "isAartApproveRegisteredForMode",
      "recordPrMergeApproval",
      "recordStandingApprovalDecision",
      "writeApprovalDecision",
      "findMatchingStandingApproval",
      "computeCapabilityClosure",
      "checkCapability",
      "getGrantedCapabilities",
      "riskForCapability",
      "semanticRiskDiff",
      "renderSemanticRiskDiff",
      "renderApprovalSummary",
      "checkWorkflowFieldCompleteness",
      "checkWorkflowStepFieldCompleteness",
      "validateWorkflow",
      "validateSchema",
      "validateReferences",
      "validateCapabilities",
      "validateInputSafety",
      "validateDeployment",
      "findEffectfulStepsWithoutIdempotencyKey",
      "computeDidYouMean",
      "redactRecord",
      "redactRecordWithNames",
      "lintSource",
      "lintRedactionBypass",
      "applyPackApprovalDecision",
      "writePackApprovalDecision",
      "isPackSealBroken",
    ] as const;

    for (const name of expectedFunctions) {
      expect(typeof (governance as Record<string, unknown>)[name], `${name} should be a function`).toBe("function");
    }
  });

  it("exports the exact frozen-signature RedactFn implementation callable with (record, resolvedSecretRefs)", () => {
    const result = governance.redactRecord({ a: "secret-x" }, new Set(["secret-x"]));
    expect(result).toEqual({ a: "[REDACTED:secret-1]" });
  });

  it("exports the exact frozen-signature CapabilityCheck implementation callable with (declared, granted)", () => {
    expect(governance.checkCapability(["http"], ["http", "browser"])).toBe(true);
    expect(governance.checkCapability(["command"], ["http"])).toBe(false);
  });

  it("exports data constants alongside the functions (REQUIRED_GATES_BY_MODE, GATE_NAMES, RISK_TIERS, COVERED_WORKFLOW_FIELDS)", () => {
    expect(governance.GATE_NAMES).toHaveLength(5);
    expect(governance.REQUIRED_GATES_BY_MODE.production).toHaveLength(5);
    expect(governance.RISK_TIERS).toEqual(["Low", "Low-medium", "Medium", "High"]);
    expect(governance.COVERED_WORKFLOW_FIELDS.length).toBeGreaterThan(0);
    expect(governance.COVERED_WORKFLOW_STEP_FIELDS.length).toBeGreaterThan(0);
  });
});
