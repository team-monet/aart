import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TAXONOMY,
  ConcurrencyPolicySchema,
  GatesSchema,
  RetryPolicySchema,
  TrustModeSchema,
  ApprovalStateSchema,
} from "./governance.js";

describe("GatesSchema", () => {
  it("round-trips a gates object (spec §17.1 example)", () => {
    const input = {
      validate: "passed" as const,
      readiness: "pending" as const,
      evals: "failed" as const,
      riskReview: "passed" as const,
      humanReview: "pending" as const,
    };
    expect(GatesSchema.parse(input)).toEqual(input);
  });

  it("rejects a gate status outside the 4-value set", () => {
    const result = GatesSchema.safeParse({
      validate: "passed",
      readiness: "pending",
      evals: "unknown",
      riskReview: "passed",
      humanReview: "pending",
    });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalStateSchema", () => {
  it("accepts the spec §17.1 3-state model", () => {
    for (const v of ["draft", "approved", "deprecated"]) {
      expect(ApprovalStateSchema.parse(v)).toBe(v);
    }
  });
});

describe("TrustModeSchema", () => {
  it("accepts the spec §17.2 4-mode set", () => {
    for (const v of ["dev", "governed", "strict", "production"]) {
      expect(TrustModeSchema.parse(v)).toBe(v);
    }
  });
});

describe("ConcurrencyPolicySchema", () => {
  it("accepts the spec §30.1 4-policy set", () => {
    for (const v of ["queue", "cancel_existing", "reject_new", "allow"]) {
      expect(ConcurrencyPolicySchema.parse(v)).toBe(v);
    }
  });

  it("rejects an unlisted policy value", () => {
    expect(ConcurrencyPolicySchema.safeParse("retry_later").success).toBe(false);
  });
});

describe("RetryPolicySchema", () => {
  it("round-trips a RetryPolicy (spec §30.3 example)", () => {
    const input = { maxAttempts: 3, backoff: "exponential", retryOn: ["timeout", "5xx"] };
    expect(RetryPolicySchema.parse(input)).toEqual(input);
  });
});

describe("CAPABILITY_TAXONOMY", () => {
  it("lists the 10 base capability tokens from spec §31.0 (secrets:<NAME>/domain:<pattern> are parameterized families, not enumerable literals)", () => {
    expect(CAPABILITY_TAXONOMY).toEqual([
      "browser",
      "http",
      "file.read",
      "file.write",
      "command",
      "email.send",
      "queue",
      "db.read",
      "db.write",
      "llm",
    ]);
  });
});
