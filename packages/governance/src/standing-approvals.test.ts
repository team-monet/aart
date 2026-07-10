import type { StandingApproval } from "@aart/types";
import { describe, expect, it } from "vitest";
import { findMatchingStandingApproval } from "./standing-approvals.js";

function sa(overrides: Partial<StandingApproval> = {}): StandingApproval {
  return {
    id: "sa_1",
    maxRiskTier: "Medium",
    capabilities: ["http", "browser"],
    grantedBy: "jane@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = "2026-07-10T00:00:00.000Z";

describe("findMatchingStandingApproval (architecture §7.5)", () => {
  it("matches when risk tier <= maxRiskTier AND capability closure ⊆ standing approval's capabilities", () => {
    const approval = sa();
    const result = findMatchingStandingApproval({ riskTier: "Low-medium", capabilityClosure: ["http"], now: NOW }, [approval]);
    expect(result).toBe(approval);
  });

  it("does not match when the workflow's risk tier exceeds maxRiskTier", () => {
    const approval = sa({ maxRiskTier: "Low" });
    const result = findMatchingStandingApproval({ riskTier: "Medium", capabilityClosure: ["http"], now: NOW }, [approval]);
    expect(result).toBeUndefined();
  });

  it("does not match when the capability closure is NOT a subset (a capability outside the granted set)", () => {
    const approval = sa({ capabilities: ["http"] });
    const result = findMatchingStandingApproval(
      { riskTier: "Medium", capabilityClosure: ["http", "command"], now: NOW },
      [approval],
    );
    expect(result).toBeUndefined();
  });

  it("does not match an expired standing approval", () => {
    const approval = sa({ expiresAt: "2020-01-01T00:00:00.000Z" });
    const result = findMatchingStandingApproval({ riskTier: "Low", capabilityClosure: [], now: NOW }, [approval]);
    expect(result).toBeUndefined();
  });

  it("treats a standing approval expiring exactly 'now' as expired (not a match)", () => {
    const approval = sa({ expiresAt: NOW });
    const result = findMatchingStandingApproval({ riskTier: "Low", capabilityClosure: [], now: NOW }, [approval]);
    expect(result).toBeUndefined();
  });

  it("fails closed on an unrecognized maxRiskTier string rather than matching everything", () => {
    const approval = sa({ maxRiskTier: "Extreme" });
    const result = findMatchingStandingApproval({ riskTier: "Low", capabilityClosure: [], now: NOW }, [approval]);
    expect(result).toBeUndefined();
  });

  it("returns the first match among several standing approvals", () => {
    const first = sa({ id: "sa_first" });
    const second = sa({ id: "sa_second" });
    const result = findMatchingStandingApproval({ riskTier: "Low", capabilityClosure: [], now: NOW }, [first, second]);
    expect(result?.id).toBe("sa_first");
  });

  it("returns undefined when no standing approvals are supplied", () => {
    expect(findMatchingStandingApproval({ riskTier: "Low", capabilityClosure: [], now: NOW }, [])).toBeUndefined();
  });
});
