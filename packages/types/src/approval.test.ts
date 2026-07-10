import { describe, expect, it } from "vitest";
import { ApprovalTaskSchema, StandingApprovalSchema } from "./approval.js";

describe("ApprovalTaskSchema", () => {
  it("round-trips a pending ApprovalTask", () => {
    const input = {
      id: "at_1",
      runId: "run_1",
      stepId: "approve_step",
      title: "Approve deployment",
      description: "Please review",
      status: "pending" as const,
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    expect(ApprovalTaskSchema.parse(input)).toEqual(input);
  });

  it("round-trips a decided ApprovalTask with reviewer/decision/decidedAt", () => {
    const input = {
      id: "at_2",
      runId: "run_1",
      stepId: "approve_step",
      title: "Approve deployment",
      description: "Please review",
      status: "approved" as const,
      reviewer: "jane@example.com",
      decision: { note: "looks good" },
      createdAt: "2026-07-10T00:00:00.000Z",
      decidedAt: "2026-07-10T01:00:00.000Z",
    };
    expect(ApprovalTaskSchema.parse(input)).toEqual(input);
  });

  it("rejects a status value outside the 5-member set (spec §13.5)", () => {
    const result = ApprovalTaskSchema.safeParse({
      id: "at_3",
      runId: "run_1",
      stepId: "approve_step",
      title: "x",
      description: "x",
      status: "maybe",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("StandingApprovalSchema", () => {
  it("round-trips a StandingApproval", () => {
    const input = {
      id: "sa_1",
      maxRiskTier: "Low",
      capabilities: ["browser", "http"],
      grantedBy: "jane@example.com",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    expect(StandingApprovalSchema.parse(input)).toEqual(input);
  });

  it("rejects a StandingApproval missing id (needed for AartStore keying, architecture §5)", () => {
    const result = StandingApprovalSchema.safeParse({
      maxRiskTier: "Low",
      capabilities: [],
      grantedBy: "jane@example.com",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
