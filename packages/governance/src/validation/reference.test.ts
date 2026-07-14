import type { Workflow, WorkflowStep } from "@aart/types";
import { describe, expect, it } from "vitest";
import type { CapabilityClosureLookup } from "../capability.js";
import { validateReferences } from "./reference.js";

const KNOWN_BLOCKS = ["browser.goto", "web.read", "assert.contains", "demo.compute", "wait.until"];
const lookup: CapabilityClosureLookup = {
  resolve: (id) => (KNOWN_BLOCKS.includes(id) ? { kind: "block", capabilities: [] } : undefined),
};

function wf(steps: WorkflowStep[]): Pick<Workflow, "execution"> {
  return { execution: { type: "workflow", steps } };
}

describe("validateReferences — class 2 (spec §18.2)", () => {
  it("returns no findings for a workflow with only valid references", () => {
    const findings = validateReferences(wf([{ id: "open", uses: "browser.goto" }]), { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS });
    expect(findings).toEqual([]);
  });

  it("flags an unknown block reference, with a didYouMean suggestion (errors-as-corrections)", () => {
    const findings = validateReferences(wf([{ id: "open", uses: "browser.got" }]), { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.class).toBe("reference");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.didYouMean).toBe("browser.goto");
    expect(findings[0]?.correctedSnippet).toContain("browser.goto");
  });

  it("flags a then/else target that doesn't exist as a step id", () => {
    const findings = validateReferences(
      wf([{ id: "check", uses: "assert.contains", then: "nonexistent_step" }]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings.some((f) => f.message.includes('"then"') && f.message.includes("nonexistent_step"))).toBe(true);
  });

  it("ALWAYS flags direct self-reference via next, even with a guard declared (spec §18.2's separate 'no direct self-reference' rule)", () => {
    const findings = validateReferences(
      wf([{ id: "loop", uses: "assert.contains", next: "loop", maxIterations: 5 }]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings.some((f) => f.message.includes("cannot directly reference itself"))).toBe(true);
  });

  it("flags an UNGUARDED back-edge as an error", () => {
    const findings = validateReferences(
      wf([
        { id: "recheck_wait", uses: "wait.until" },
        { id: "rescan", uses: "demo.compute", next: "recheck_wait" }, // no maxIterations/until
      ]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings.some((f) => f.message.includes("unguarded cycles are validation errors") || f.message.includes("without"))).toBe(true);
  });

  it("ACCEPTS a guarded back-edge — the exact spec §18.2 worked example (rescan -> recheck_wait, maxIterations on the DECLARING step)", () => {
    const findings = validateReferences(
      wf([
        { id: "recheck_wait", uses: "wait.until" },
        { id: "rescan", uses: "demo.compute", maxIterations: 6, next: "recheck_wait" },
      ]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings).toEqual([]);
  });

  it("also accepts a guard declared via 'until' instead of maxIterations", () => {
    const findings = validateReferences(
      wf([
        { id: "recheck_wait", uses: "wait.until" },
        { id: "rescan", uses: "demo.compute", until: "{{ steps.rescan.outputs.done }}", next: "recheck_wait" },
      ]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings).toEqual([]);
  });

  it("does not flag a FORWARD next reference (not a back-edge) even without a guard", () => {
    const findings = validateReferences(
      wf([
        { id: "a", uses: "browser.goto", next: "b" },
        { id: "b", uses: "web.read" },
      ]),
      { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS },
    );
    expect(findings).toEqual([]);
  });

  it("flags a next target that doesn't exist as a step id at all", () => {
    const findings = validateReferences(wf([{ id: "a", uses: "browser.goto", next: "ghost" }]), { blockCatalog: lookup, knownBlockIds: KNOWN_BLOCKS });
    expect(findings.some((f) => f.message.includes("ghost"))).toBe(true);
  });
});
