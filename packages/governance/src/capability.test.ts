import type { StandingApproval, WorkflowStep } from "@aart/types";
import { describe, expect, it } from "vitest";
import {
  type CapabilityClosureLookup,
  checkCapability,
  compareRiskTiers,
  computeCapabilityClosure,
  getGrantedCapabilities,
  maxRiskTier,
  normalizeEnvironmentTrustMode,
  riskForCapability,
} from "./capability.js";

function step(id: string, uses: string): WorkflowStep {
  return { id, uses };
}

describe("riskForCapability (spec §31.1)", () => {
  it("maps every documented capability to its exact table risk tier", () => {
    expect(riskForCapability("file.read")).toBe("Low-medium");
    expect(riskForCapability("file.write")).toBe("Medium");
    expect(riskForCapability("http")).toBe("Medium");
    expect(riskForCapability("browser")).toBe("Medium");
    expect(riskForCapability("llm")).toBe("Medium");
    expect(riskForCapability("email.send")).toBe("High");
    expect(riskForCapability("command")).toBe("High");
    expect(riskForCapability("db.write")).toBe("High");
  });

  it("maps parameterized families (secrets:<NAME>, domain:<pattern>) to High regardless of the parameter", () => {
    expect(riskForCapability("secrets:GITHUB_TOKEN")).toBe("High");
    expect(riskForCapability("secrets:ANYTHING")).toBe("High");
    expect(riskForCapability("domain:api.github.com")).toBe("High");
    expect(riskForCapability("domain:*.internal.company.com")).toBe("High");
  });

  it("interpolates queue/db.read (table gaps, see AMENDMENTS.md) to Medium, not silently Low", () => {
    expect(riskForCapability("queue")).toBe("Medium");
    expect(riskForCapability("db.read")).toBe("Medium");
  });

  it("defaults an unrecognized capability to High (fail-closed, never silently Low)", () => {
    expect(riskForCapability("stripe.charge")).toBe("High");
    expect(riskForCapability("some.future.capability")).toBe("High");
  });
});

describe("maxRiskTier / compareRiskTiers", () => {
  it("orders Low < Low-medium < Medium < High", () => {
    expect(compareRiskTiers("Low", "High")).toBeLessThan(0);
    expect(compareRiskTiers("High", "Low")).toBeGreaterThan(0);
    expect(compareRiskTiers("Medium", "Medium")).toBe(0);
  });

  it("returns Low for an empty tier list", () => {
    expect(maxRiskTier([])).toBe("Low");
  });

  it("returns the maximum, not an average", () => {
    expect(maxRiskTier(["Low", "Low", "Low", "High", "Low"])).toBe("High");
  });
});

describe("computeCapabilityClosure — ceiling function over transitive closure (architecture §7.4)", () => {
  it("one High-risk step among 40 Low-risk steps makes the whole closure High, not averaged down", () => {
    const lowSteps: WorkflowStep[] = Array.from({ length: 40 }, (_, i) => step(`low_${i}`, "assert.equals"));
    const steps: WorkflowStep[] = [...lowSteps, step("the_one_risky_step", "command.run")];
    const lookup: CapabilityClosureLookup = {
      resolve(blockId) {
        if (blockId === "assert.equals") return { kind: "block", capabilities: [] };
        if (blockId === "command.run") return { kind: "block", capabilities: ["command"] };
        return undefined;
      },
    };
    const result = computeCapabilityClosure(steps, lookup);
    expect(result.riskTier).toBe("High");
    expect(result.capabilities).toEqual(["command"]);
  });

  it("walks transitively through workflow-type (composed) blocks — a nested workflow-block's own steps count toward the closure", () => {
    const steps: WorkflowStep[] = [step("s1", "composed.sub_workflow")];
    const lookup: CapabilityClosureLookup = {
      resolve(blockId) {
        if (blockId === "composed.sub_workflow") {
          return { kind: "workflow", steps: [step("inner1", "http.request"), step("inner2", "email.send")] };
        }
        if (blockId === "http.request") return { kind: "block", capabilities: ["http"] };
        if (blockId === "email.send") return { kind: "block", capabilities: ["email.send"] };
        return undefined;
      },
    };
    const result = computeCapabilityClosure(steps, lookup);
    expect(result.capabilities).toEqual(["email.send", "http"]);
    expect(result.riskTier).toBe("High"); // email.send dominates http
  });

  it("returns Low risk and an empty capability set for a workflow with no capability-declaring steps", () => {
    const steps: WorkflowStep[] = [step("s1", "assert.equals"), step("s2", "data.map")];
    const lookup: CapabilityClosureLookup = {
      resolve: () => ({ kind: "block", capabilities: [] }),
    };
    const result = computeCapabilityClosure(steps, lookup);
    expect(result.capabilities).toEqual([]);
    expect(result.riskTier).toBe("Low");
  });

  it("surfaces unresolvable block references rather than silently dropping them", () => {
    const steps: WorkflowStep[] = [step("s1", "nonexistent.block")];
    const lookup: CapabilityClosureLookup = { resolve: () => undefined };
    const result = computeCapabilityClosure(steps, lookup);
    expect(result.unresolved).toEqual(["nonexistent.block"]);
    expect(result.capabilities).toEqual([]);
  });

  it("guards against infinite recursion on a cyclic block composition", () => {
    const steps: WorkflowStep[] = [step("s1", "a")];
    const lookup: CapabilityClosureLookup = {
      resolve(blockId) {
        if (blockId === "a") return { kind: "workflow", steps: [step("x", "b")] };
        if (blockId === "b") return { kind: "workflow", steps: [step("y", "a")] }; // cycle back to "a"
        return undefined;
      },
    };
    expect(() => computeCapabilityClosure(steps, lookup)).not.toThrow();
  });

  it("dedupes repeated capabilities across multiple steps", () => {
    const steps: WorkflowStep[] = [step("s1", "http.request"), step("s2", "http.request")];
    const lookup: CapabilityClosureLookup = { resolve: () => ({ kind: "block", capabilities: ["http"] }) };
    const result = computeCapabilityClosure(steps, lookup);
    expect(result.capabilities).toEqual(["http"]);
  });
});

describe("checkCapability — the real CapabilityCheck implementation (architecture §4.6/ADR-09)", () => {
  it("allows when declared is a subset of granted", () => {
    expect(checkCapability(["http"], ["http", "browser"])).toBe(true);
    expect(checkCapability([], ["http"])).toBe(true);
    expect(checkCapability([], [])).toBe(true);
  });

  it("denies when declared has anything outside granted", () => {
    expect(checkCapability(["command"], ["http", "browser"])).toBe(false);
    expect(checkCapability(["http", "command"], ["http"])).toBe(false);
  });

  it("matches the CapabilityCheck type's exact 2-arg (declared, granted) => boolean signature", () => {
    expect(checkCapability.length).toBe(2);
    expect(typeof checkCapability(["x"], ["x"])).toBe("boolean");
  });
});

describe("getGrantedCapabilities — the granted-set policy query architecture §4.6's dispatch pseudocode calls", () => {
  it("dev mode grants the full closure unconditionally, even when draft — dev 'runs with a warning', it is not capability-gated", () => {
    const granted = getGrantedCapabilities({
      trustMode: "dev",
      approvalState: "draft",
      capabilityClosure: ["command", "browser"],
      riskTier: "High",
    });
    expect(granted).toEqual(["command", "browser"]);
  });

  it("governed/strict/production grant the full closure once the version is globally approved", () => {
    const granted = getGrantedCapabilities({
      trustMode: "production",
      approvalState: "approved",
      capabilityClosure: ["http"],
      riskTier: "Medium",
    });
    expect(granted).toEqual(["http"]);
  });

  it("grants NOTHING for a draft, non-dev-mode workflow with no matching standing approval — fail-closed by default", () => {
    const granted = getGrantedCapabilities({
      trustMode: "governed",
      approvalState: "draft",
      capabilityClosure: ["http"],
      riskTier: "Medium",
    });
    expect(granted).toEqual([]);
  });

  it("grants the full closure for a draft workflow when a matching standing approval covers it (architecture §7.5)", () => {
    const standingApproval: StandingApproval = {
      id: "sa_1",
      maxRiskTier: "Medium",
      capabilities: ["http", "browser"],
      grantedBy: "ops@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const granted = getGrantedCapabilities({
      trustMode: "governed",
      approvalState: "draft",
      capabilityClosure: ["http"],
      riskTier: "Medium",
      standingApprovals: [standingApproval],
      now: "2026-07-10T00:00:00.000Z",
    });
    expect(granted).toEqual(["http"]);
  });

  it("still grants nothing for a draft workflow whose risk exceeds every standing approval's maxRiskTier", () => {
    const standingApproval: StandingApproval = {
      id: "sa_1",
      maxRiskTier: "Low",
      capabilities: ["command"],
      grantedBy: "ops@example.com",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const granted = getGrantedCapabilities({
      trustMode: "governed",
      approvalState: "draft",
      capabilityClosure: ["command"],
      riskTier: "High",
      standingApprovals: [standingApproval],
      now: "2026-07-10T00:00:00.000Z",
    });
    expect(granted).toEqual([]);
  });

  it("feeds checkCapability correctly end-to-end: a declared set within the granted closure passes, one outside it fails", () => {
    const granted = getGrantedCapabilities({
      trustMode: "production",
      approvalState: "approved",
      capabilityClosure: ["http", "browser"],
      riskTier: "Medium",
    });
    expect(checkCapability(["http"], granted)).toBe(true);
    expect(checkCapability(["command"], granted)).toBe(false);
  });
});

describe("normalizeEnvironmentTrustMode (AMENDMENTS.md S15 — settling the S11/A42 governance-permissiveness finding)", () => {
  it("passes through each of the four real trust-mode values unchanged", () => {
    expect(normalizeEnvironmentTrustMode("dev")).toBe("dev");
    expect(normalizeEnvironmentTrustMode("governed")).toBe("governed");
    expect(normalizeEnvironmentTrustMode("strict")).toBe("strict");
    expect(normalizeEnvironmentTrustMode("production")).toBe("production");
  });

  it("falls back to 'governed' (spec §17.2's own stated local-development default) for an absent or unrecognized value — never 'dev'", () => {
    expect(normalizeEnvironmentTrustMode(undefined)).toBe("governed");
    expect(normalizeEnvironmentTrustMode(null)).toBe("governed");
    expect(normalizeEnvironmentTrustMode("")).toBe("governed");
    expect(normalizeEnvironmentTrustMode("not-a-real-mode")).toBe("governed");
    expect(normalizeEnvironmentTrustMode(42)).toBe("governed");
  });
});
