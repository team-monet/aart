import type { WorkflowStep } from "@aart/types";
import { describe, expect, it } from "vitest";
import { renderSemanticRiskDiff, semanticRiskDiff } from "./risk-diff.js";
import { computeCapabilityClosure, type CapabilityClosureLookup } from "./capability.js";

const lookup: CapabilityClosureLookup = {
  resolve(blockId) {
    switch (blockId) {
      case "browser.goto":
      case "browser.click":
      case "browser.screenshot":
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

describe("semanticRiskDiff — checkout-smoke v0.1.0 -> v0.2.0 (spec §17.4's own worked example topology)", () => {
  // v0.1.0: open/read/assert("Checkout")/screenshot. v0.2.0: adds a
  // browser.click submit step and changes the assertion's expected text
  // "Checkout" -> "Payment" — the exact shape of spec §17.4's own example.
  const v1Steps: WorkflowStep[] = [
    { id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } },
    { id: "read", uses: "web.read" },
    { id: "assert", uses: "assert.contains", with: { value: "{{ steps.read.outputs.text }}", expected: "Checkout" } },
    { id: "screenshot", uses: "browser.screenshot", with: { name: "checkout" } },
  ];
  const v2Steps: WorkflowStep[] = [
    { id: "open", uses: "browser.goto", with: { url: "{{ inputs.url }}" } },
    { id: "read", uses: "web.read" },
    { id: "click_submit", uses: "browser.click", with: { selector: "text=Submit" } },
    { id: "assert", uses: "assert.contains", with: { value: "{{ steps.read.outputs.text }}", expected: "Payment" } },
    { id: "screenshot", uses: "browser.screenshot", with: { name: "checkout" } },
    // New artifact (spec §17.4's "New artifact: checkout-after-submit.png"
    // bullet) is a NEW screenshot step, not a rename of the existing one —
    // this keeps the original "screenshot" step's own `with` untouched, so
    // it doesn't ALSO show up as "modified" alongside the assertion.
    { id: "screenshot_after_submit", uses: "browser.screenshot", with: { name: "checkout-after-submit" } },
  ];

  const fromClosure = computeCapabilityClosure(v1Steps, lookup);
  const toClosure = computeCapabilityClosure(v2Steps, lookup);
  const diff = semanticRiskDiff({ steps: v1Steps, capabilityClosure: fromClosure }, { steps: v2Steps, capabilityClosure: toClosure });

  it("classifies the new submit step and the new post-submit screenshot as added", () => {
    expect(diff.added).toEqual(
      expect.arrayContaining([
        { stepId: "click_submit", uses: "browser.click" },
        { stepId: "screenshot_after_submit", uses: "browser.screenshot" },
      ]),
    );
    expect(diff.added).toHaveLength(2);
  });

  it("classifies the assertion-text change as modified, with a field-level detail", () => {
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]?.stepId).toBe("assert");
    expect(diff.modified[0]?.details.some((d) => d.includes("Checkout") && d.includes("Payment"))).toBe(true);
  });

  it("reports no NEW capability for this specific fixture — 'browser' was already present via browser.goto/web.read/browser.screenshot in v0.1.0, so adding browser.click (same coarse capability) doesn't change the closure", () => {
    // This is a real, worth-flagging consequence of spec §31.0's OWN coarse
    // "capabilities are coarse grants ... not one capability per block"
    // design: a workflow that already declares `browser` cannot show a
    // capability-level risk delta from a SECOND browser.* step, even one
    // that behaviorally adds a write action (a form submit) — the spec's
    // own §17.4 prose example ("Risk increased Low -> Medium") is an
    // illustrative narrative, not mechanically derived from the formal
    // §31.1 risk table it sits alongside (this is a spec-internal
    // consistency gap between prose and taxonomy, not a bug in this
    // implementation — see the dedicated risk-tier-delta test below, which
    // proves the SAME mechanism correctly reports Low -> Medium once the
    // closure genuinely gains a new capability).
    expect(diff.newCapabilities).toEqual([]);
    expect(diff.capabilityChanged).toBe(false);
    expect(diff.riskFrom).toBe("Medium");
    expect(diff.riskTo).toBe("Medium");
    expect(diff.riskIncreased).toBe(false);
  });

  it("renders the spec §17.4 structured text format (Changes from.../Added:/Changed:)", () => {
    const rendered = renderSemanticRiskDiff(diff, { fromVersion: "0.1.0", toVersion: "0.2.0", requiredGates: ["human approval", "smoke eval must pass"] });
    expect(rendered).toContain("Changes from approved v0.1.0 -> draft v0.2.0");
    expect(rendered).toContain("Added:");
    expect(rendered).toContain("- New step: browser.click (click_submit)");
    expect(rendered).toContain("Changed:");
    expect(rendered).toContain("Required:");
    expect(rendered).toContain("- human approval");
  });
});

describe("semanticRiskDiff — risk-tier delta is a genuine ceiling-function recompute (Low -> Medium -> High)", () => {
  it("detects a Low -> Medium increase when a new capability-bearing step is added", () => {
    const v1: WorkflowStep[] = [{ id: "check", uses: "assert.contains", with: { value: "x", expected: "x" } }];
    const v2: WorkflowStep[] = [...v1, { id: "open", uses: "browser.goto", with: { url: "https://example.com" } }];
    const fromClosure = computeCapabilityClosure(v1, lookup);
    const toClosure = computeCapabilityClosure(v2, lookup);
    const diff = semanticRiskDiff({ steps: v1, capabilityClosure: fromClosure }, { steps: v2, capabilityClosure: toClosure });
    expect(diff.riskFrom).toBe("Low");
    expect(diff.riskTo).toBe("Medium");
    expect(diff.riskIncreased).toBe(true);
    expect(diff.newCapabilities).toEqual(["browser"]);
  });

  it("detects a Medium -> High increase when a command step is added", () => {
    const v1: WorkflowStep[] = [{ id: "open", uses: "browser.goto", with: { url: "https://example.com" } }];
    const v2: WorkflowStep[] = [...v1, { id: "run", uses: "command.run", with: { bin: "gh", args: ["pr", "list"] } }];
    const fromClosure = computeCapabilityClosure(v1, lookup);
    const toClosure = computeCapabilityClosure(v2, lookup);
    const diff = semanticRiskDiff({ steps: v1, capabilityClosure: fromClosure }, { steps: v2, capabilityClosure: toClosure });
    expect(diff.riskFrom).toBe("Medium");
    expect(diff.riskTo).toBe("High");
    expect(diff.riskIncreased).toBe(true);
  });

  it("does not report an increase when risk stays the same or decreases", () => {
    const v1: WorkflowStep[] = [{ id: "run", uses: "command.run", with: {} }];
    const v2: WorkflowStep[] = [];
    const fromClosure = computeCapabilityClosure(v1, lookup);
    const toClosure = computeCapabilityClosure(v2, lookup);
    const diff = semanticRiskDiff({ steps: v1, capabilityClosure: fromClosure }, { steps: v2, capabilityClosure: toClosure });
    expect(diff.riskFrom).toBe("High");
    expect(diff.riskTo).toBe("Low");
    expect(diff.riskIncreased).toBe(false);
  });
});

describe("semanticRiskDiff — removal and no-op cases", () => {
  it("classifies a removed step correctly", () => {
    const v1: WorkflowStep[] = [{ id: "a", uses: "assert.contains", with: {} }, { id: "b", uses: "web.read" }];
    const v2: WorkflowStep[] = [{ id: "a", uses: "assert.contains", with: {} }];
    const fromClosure = computeCapabilityClosure(v1, lookup);
    const toClosure = computeCapabilityClosure(v2, lookup);
    const diff = semanticRiskDiff({ steps: v1, capabilityClosure: fromClosure }, { steps: v2, capabilityClosure: toClosure });
    expect(diff.removed).toEqual([{ stepId: "b", uses: "web.read" }]);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("reports no changes at all for an identical workflow", () => {
    const steps: WorkflowStep[] = [{ id: "a", uses: "assert.contains", with: { x: 1 } }];
    const closure = computeCapabilityClosure(steps, lookup);
    const diff = semanticRiskDiff({ steps, capabilityClosure: closure }, { steps, capabilityClosure: closure });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.riskIncreased).toBe(false);
  });
});
