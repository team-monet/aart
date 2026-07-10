import type { Workflow } from "@aart/types";
import { describe, expect, it } from "vitest";
import type { CapabilityClosureLookup } from "../capability.js";
import { validateWorkflow, type ValidationContext } from "./index.js";

const KNOWN_BLOCKS = ["browser.goto", "web.read", "assert.contains", "command.run"];
const lookup: CapabilityClosureLookup = {
  resolve(blockId) {
    switch (blockId) {
      case "browser.goto":
        return { kind: "block", capabilities: ["browser"] };
      case "web.read":
        return { kind: "block", capabilities: ["browser"] };
      case "assert.contains":
        return { kind: "block", capabilities: [] };
      case "command.run":
        return { kind: "block", capabilities: ["command"] };
      default:
        return undefined;
    }
  },
};

function baseContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS, trustMode: "governed", ...overrides };
}

function validWorkflowWithSteps(steps: Workflow["execution"]["steps"], overrides: Partial<Workflow> = {}): unknown {
  return {
    id: "wf",
    name: "n",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    ...overrides,
  };
}

describe("validateWorkflow — full 5-class orchestrator (architecture §7.7)", () => {
  it("passes a fully valid, approved, low-capability workflow", () => {
    const result = validateWorkflow(validWorkflowWithSteps([{ id: "check", uses: "assert.contains", with: { a: 1 } }]), baseContext());
    expect(result.valid).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.capabilityClosure?.capabilities).toEqual([]);
  });

  it("short-circuits after class 1 (schema) — no reference/capability/input-safety findings run against an unparseable input", () => {
    const result = validateWorkflow({ id: "wf" }, baseContext()); // missing everything else
    expect(result.valid).toBe(false);
    expect(result.findings.every((f) => f.class === "schema")).toBe(true);
    expect(result.capabilityClosure).toBeUndefined();
  });

  it("class 2: flags a deliberately-misspelled block name with a didYouMean suggestion against the real (fixture) catalog", () => {
    const result = validateWorkflow(validWorkflowWithSteps([{ id: "open", uses: "browser.got" }]), baseContext());
    expect(result.valid).toBe(false);
    const referenceFinding = result.findings.find((f) => f.class === "reference");
    expect(referenceFinding?.didYouMean).toBe("browser.goto");
  });

  it("class 3: flags a required-but-not-granted capability for a draft workflow in governed mode", () => {
    const result = validateWorkflow(
      validWorkflowWithSteps([{ id: "open", uses: "browser.goto" }], { approval: "draft" }),
      baseContext(),
    );
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.class === "capability")).toBe(true);
  });

  it("class 3: an APPROVED workflow's own capabilities are self-granted (no capability finding)", () => {
    const result = validateWorkflow(validWorkflowWithSteps([{ id: "open", uses: "browser.goto" }]), baseContext());
    expect(result.findings.some((f) => f.class === "capability")).toBe(false);
  });

  it("class 4 WARNING never blocks validation from otherwise passing", () => {
    const result = validateWorkflow(
      validWorkflowWithSteps([{ id: "run", uses: "command.run" }]), // effectful, no idempotencyKey — but approved, so no capability finding either since command IS in this workflow's own closure and it's approved
      baseContext(),
    );
    const warning = result.findings.find((f) => f.message.includes("idempotencyKey"));
    expect(warning?.severity).toBe("warning");
    expect(result.valid).toBe(true); // warnings never block
  });

  it("class 5 (deployment) only runs when a deployment context is supplied", () => {
    const withoutDeployment = validateWorkflow(validWorkflowWithSteps([{ id: "open", uses: "browser.goto" }]), baseContext());
    expect(withoutDeployment.findings.some((f) => f.class === "deployment")).toBe(false);

    const withDeployment = validateWorkflow(
      validWorkflowWithSteps([{ id: "open", uses: "browser.goto" }]),
      baseContext({
        deployment: {
          targetCapabilities: [], // deliberately doesn't support "browser"
          availableSecrets: [],
          waitStoreConfigured: true,
          artifactStoreConfigured: true,
          requiredGates: [],
        },
      }),
    );
    expect(withDeployment.findings.some((f) => f.class === "deployment")).toBe(true);
    expect(withDeployment.valid).toBe(false);
  });

  it("merges findings from multiple classes in one call", () => {
    const result = validateWorkflow(
      validWorkflowWithSteps(
        [
          { id: "open", uses: "browser.got" }, // class 2: unknown block
          { id: "run", uses: "command.run", with: { arg: "safe; rm -rf /" } }, // class 4: shell metachar + idempotencyKey warning
        ],
        { approval: "draft" }, // class 3: capabilities not yet granted
      ),
      baseContext(),
    );
    const classes = new Set(result.findings.map((f) => f.class));
    expect(classes.has("reference")).toBe(true);
    expect(classes.has("capability")).toBe(true);
    expect(classes.has("input-safety")).toBe(true);
    expect(result.valid).toBe(false);
  });

  it("respects a standing approval that covers a draft workflow's closure — no capability finding", () => {
    const result = validateWorkflow(
      validWorkflowWithSteps([{ id: "open", uses: "browser.goto" }], { approval: "draft" }),
      baseContext({
        standingApprovals: [
          { id: "sa1", maxRiskTier: "Medium", capabilities: ["browser"], grantedBy: "ops@example.com", expiresAt: "2099-01-01T00:00:00.000Z" },
        ],
        now: "2026-07-10T00:00:00.000Z",
      }),
    );
    expect(result.findings.some((f) => f.class === "capability")).toBe(false);
  });

  it("dev mode never blocks on capability approval, even for a draft workflow with a High-risk closure", () => {
    const result = validateWorkflow(
      validWorkflowWithSteps([{ id: "run", uses: "command.run", with: {}, idempotencyKey: "{{ run.id }}" }], { approval: "draft" }),
      baseContext({ trustMode: "dev" }),
    );
    expect(result.findings.some((f) => f.class === "capability")).toBe(false);
  });
});
