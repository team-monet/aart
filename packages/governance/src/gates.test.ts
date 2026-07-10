import { describe, expect, it } from "vitest";
import { AART_APPROVE_TOOL_NAME, GATE_NAMES, isAartApproveRegisteredForMode, REQUIRED_GATES_BY_MODE } from "./gates.js";

describe("REQUIRED_GATES_BY_MODE (architecture §7.3)", () => {
  it("dev requires nothing", () => {
    expect(REQUIRED_GATES_BY_MODE.dev).toEqual([]);
  });

  it("governed requires validate + humanReview", () => {
    expect(REQUIRED_GATES_BY_MODE.governed).toEqual(["validate", "humanReview"]);
  });

  it("strict requires the SAME gate set as governed (the difference is the approval surface, not the gates)", () => {
    expect(REQUIRED_GATES_BY_MODE.strict).toEqual(REQUIRED_GATES_BY_MODE.governed);
  });

  it("production requires all five gates", () => {
    expect(REQUIRED_GATES_BY_MODE.production).toEqual(GATE_NAMES);
    expect(REQUIRED_GATES_BY_MODE.production).toHaveLength(5);
  });
});

describe("aart_approve mode-gating (spec §17.5)", () => {
  it("is registered in dev and governed", () => {
    expect(isAartApproveRegisteredForMode("dev")).toBe(true);
    expect(isAartApproveRegisteredForMode("governed")).toBe(true);
  });

  it("is NOT registered in strict or production", () => {
    expect(isAartApproveRegisteredForMode("strict")).toBe(false);
    expect(isAartApproveRegisteredForMode("production")).toBe(false);
  });

  it("exposes the exact tool name spec §17.5 names", () => {
    expect(AART_APPROVE_TOOL_NAME).toBe("aart_approve");
  });
});
