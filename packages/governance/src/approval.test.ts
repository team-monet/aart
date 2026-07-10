import type { Gates, TrustMode } from "@aart/types";
import { describe, expect, it } from "vitest";
import { computeApprovalState, computePromotionState, evaluatePromotionForEnvironment } from "./approval.js";
import { REQUIRED_GATES_BY_MODE } from "./gates.js";

const ALL_PENDING: Gates = { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" };
const ALL_PASSED: Gates = { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" };
const ALL_WAIVED: Gates = { validate: "waived", readiness: "waived", evals: "waived", riskReview: "waived", humanReview: "waived" };

describe("computeApprovalState — every trust-mode x gate-combination (architecture §7.3)", () => {
  const modes: TrustMode[] = ["dev", "governed", "strict", "production"];

  it("dev NEVER auto-flips to approved, even with every gate passed (architecture §7.3: 'approval never auto-flips')", () => {
    expect(computeApprovalState(ALL_PASSED, REQUIRED_GATES_BY_MODE.dev)).toBe("draft");
    expect(computeApprovalState(ALL_WAIVED, REQUIRED_GATES_BY_MODE.dev)).toBe("draft");
    expect(computeApprovalState(ALL_PENDING, REQUIRED_GATES_BY_MODE.dev)).toBe("draft");
  });

  it("governed approves once validate+humanReview pass, independent of the other three gates", () => {
    const gates: Gates = { ...ALL_PENDING, validate: "passed", humanReview: "passed" };
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.governed)).toBe("approved");
  });

  it("governed stays draft if only ONE of its two required gates passed", () => {
    expect(computeApprovalState({ ...ALL_PENDING, validate: "passed" }, REQUIRED_GATES_BY_MODE.governed)).toBe("draft");
    expect(computeApprovalState({ ...ALL_PENDING, humanReview: "passed" }, REQUIRED_GATES_BY_MODE.governed)).toBe("draft");
  });

  it("governed treats waived the same as passed", () => {
    const gates: Gates = { ...ALL_PENDING, validate: "waived", humanReview: "passed" };
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.governed)).toBe("approved");
  });

  it("strict uses the identical gate requirement as governed (same result for the same gates)", () => {
    const gates: Gates = { ...ALL_PENDING, validate: "passed", humanReview: "passed" };
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.strict)).toBe(
      computeApprovalState(gates, REQUIRED_GATES_BY_MODE.governed),
    );
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.strict)).toBe("approved");
  });

  it("production requires ALL FIVE gates — four of five passed is still draft", () => {
    const gates: Gates = { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "pending" };
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.production)).toBe("draft");
  });

  it("production approves once all five pass (or are waived)", () => {
    expect(computeApprovalState(ALL_PASSED, REQUIRED_GATES_BY_MODE.production)).toBe("approved");
    expect(computeApprovalState(ALL_WAIVED, REQUIRED_GATES_BY_MODE.production)).toBe("approved");
  });

  it("production is draft if even one required gate FAILED (not just pending)", () => {
    const gates: Gates = { ...ALL_PASSED, evals: "failed" };
    expect(computeApprovalState(gates, REQUIRED_GATES_BY_MODE.production)).toBe("draft");
  });

  it.each(modes)("full sweep: %s mode against all-pending and all-passed gates", (mode) => {
    const required = REQUIRED_GATES_BY_MODE[mode];
    const pendingResult = computeApprovalState(ALL_PENDING, required);
    const passedResult = computeApprovalState(ALL_PASSED, required);
    expect(pendingResult).toBe("draft");
    if (mode === "dev") {
      expect(passedResult).toBe("draft");
    } else {
      expect(passedResult).toBe("approved");
    }
  });
});

describe("computePromotionState — staging-vs-production divergence (ADR-07 rationale)", () => {
  // Same workflow version, same underlying gates: staging requires fewer
  // gates than production, so the SAME gates object promotes for staging
  // while production's stricter set is not yet satisfied.
  const gates: Gates = { validate: "passed", readiness: "passed", evals: "pending", riskReview: "pending", humanReview: "passed" };
  const stagingRequired = REQUIRED_GATES_BY_MODE.governed; // validate + humanReview
  const productionRequired = REQUIRED_GATES_BY_MODE.production; // all five

  it("promotes for staging's smaller required-gate set", () => {
    const record = computePromotionState("approved", gates, stagingRequired, "staging");
    expect(record.promoted).toBe(true);
    expect(record.unmetGates).toEqual([]);
  });

  it("does NOT promote for production's stricter required-gate set, same gates/version", () => {
    const record = computePromotionState("approved", gates, productionRequired, "production");
    expect(record.promoted).toBe(false);
    expect(record.unmetGates).toEqual(["evals", "riskReview"]);
  });

  it("never promotes if the global approval itself is still draft, regardless of environment gates", () => {
    const record = computePromotionState("draft", ALL_PASSED, stagingRequired, "staging");
    expect(record.promoted).toBe(false);
  });

  it("is pure: never mutates the gates object or globalApproval input it was given", () => {
    const gatesCopy = { ...gates };
    const before = computeApprovalState(gates, stagingRequired);
    computePromotionState("approved", gates, productionRequired, "production");
    expect(gates).toEqual(gatesCopy);
    const after = computeApprovalState(gates, stagingRequired);
    expect(after).toBe(before);
  });

  it("never returns anything resembling a write to the workflow version's global `approval` field — the record's `globalApproval` is an ECHO of the input, and the function has no side channel to write elsewhere", () => {
    const record = computePromotionState("approved", gates, stagingRequired, "staging");
    expect(record.globalApproval).toBe("approved");
    expect(Object.keys(record).sort()).toEqual(["environment", "globalApproval", "promoted", "requiredGates", "unmetGates"].sort());
  });
});

describe("evaluatePromotionForEnvironment — refuses while promotionBlocked (architecture §7.1/§9.4)", () => {
  it("refuses to produce a promotion record while workflow.promotionBlocked is true, even with every gate passed", () => {
    const result = evaluatePromotionForEnvironment({
      workflow: { promotionBlocked: true },
      globalApproval: "approved",
      gates: ALL_PASSED,
      requiredGatesForEnvironment: REQUIRED_GATES_BY_MODE.production,
      environment: "production",
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.reason).toBe("promotion_blocked");
    }
  });

  it("produces a normal promotion record when promotionBlocked is false", () => {
    const result = evaluatePromotionForEnvironment({
      workflow: { promotionBlocked: false },
      globalApproval: "approved",
      gates: ALL_PASSED,
      requiredGatesForEnvironment: REQUIRED_GATES_BY_MODE.production,
      environment: "production",
    });
    expect(result.blocked).toBe(false);
    if (!result.blocked) {
      expect(result.record.promoted).toBe(true);
    }
  });

  it("produces a normal (unpromoted) record when promotionBlocked is undefined/absent — refusal is opt-in via an explicit true, not a default-deny on a missing flag", () => {
    const result = evaluatePromotionForEnvironment({
      workflow: {},
      globalApproval: "draft",
      gates: ALL_PENDING,
      requiredGatesForEnvironment: REQUIRED_GATES_BY_MODE.governed,
      environment: "staging",
    });
    expect(result.blocked).toBe(false);
  });

  it("computePromotionState's own 4-argument signature is untouched by the refusal wrapper — the block is a call-site gate, not a new parameter", () => {
    // Type-level assertion via arity check — computePromotionState must
    // still be callable with exactly 4 positional args.
    expect(computePromotionState.length).toBe(4);
  });
});
