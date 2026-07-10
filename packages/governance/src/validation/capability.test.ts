import { describe, expect, it } from "vitest";
import type { CapabilityClosureResult } from "../capability.js";
import { validateCapabilities } from "./capability.js";

describe("validateCapabilities — class 3 (spec §18.3)", () => {
  it("flags a capability in the closure that isn't in the granted set — a validation-time preview of the dispatch check", () => {
    const closure: CapabilityClosureResult = { capabilities: ["browser", "command"], riskTier: "High", unresolved: [] };
    const findings = validateCapabilities(closure, { granted: ["browser"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.class).toBe("capability");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("command");
  });

  it("returns no findings when every closure capability is granted", () => {
    const closure: CapabilityClosureResult = { capabilities: ["browser", "http"], riskTier: "Medium", unresolved: [] };
    const findings = validateCapabilities(closure, { granted: ["browser", "http", "llm"] });
    expect(findings).toEqual([]);
  });

  it("returns no findings for an empty closure regardless of granted", () => {
    const closure: CapabilityClosureResult = { capabilities: [], riskTier: "Low", unresolved: [] };
    expect(validateCapabilities(closure, { granted: [] })).toEqual([]);
  });
});
