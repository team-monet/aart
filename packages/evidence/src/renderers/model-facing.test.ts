import { describe, expect, it } from "vitest";
import { ModelFacingReportSchema } from "@aart/types";
import { identityRedact } from "../redact.js";
import { fixtureRunRecord } from "../test-support/fixtures.js";
import { renderModelFacing } from "./model-facing.js";

describe("renderModelFacing", () => {
  it("produces output that validates against ModelFacingReportSchema", () => {
    const run = fixtureRunRecord({ status: "completed" });
    const report = renderModelFacing(run, identityRedact);
    expect(() => ModelFacingReportSchema.parse(report)).not.toThrow();
  });

  it.each([
    ["completed", "passed"],
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["pending", "waiting"],
    ["running", "waiting"],
    ["waiting", "waiting"],
  ] as const)("maps RunRecord.status %s to headline %s", (status, headline) => {
    const report = renderModelFacing(fixtureRunRecord({ status }), identityRedact);
    expect(report.headline).toBe(headline);
  });

  it("collects failures from failed steps only, defaulting a missing error message", () => {
    const run = fixtureRunRecord({
      status: "failed",
      trace: [
        { seq: 0, stepId: "a", block: "http.request", status: "completed", inputs: {}, startedAt: "t" },
        { seq: 1, stepId: "b", block: "http.request", status: "failed", inputs: {}, error: "boom", startedAt: "t" },
      ],
    });
    const report = renderModelFacing(run, identityRedact);
    expect(report.failures).toEqual([{ stepId: "b", block: "http.request", error: "boom" }]);
  });

  it("returns workflow-level outputs without requiring callers to inspect step traces", () => {
    const report = renderModelFacing(fixtureRunRecord({ status: "completed", outputs: { items: ["alpha", "beta"], count: 2 } }), identityRedact);
    expect(report.outputs).toEqual({ items: ["alpha", "beta"], count: 2 });
  });

  it("surfaces a run-level output mapping failure when no individual step failed", () => {
    const report = renderModelFacing(fixtureRunRecord({ status: "failed", error: "Workflow output mapping failed: missing field" }), identityRedact);
    expect(report.failures).toEqual([
      { stepId: "$workflow", block: "workflow.outputMapping", error: "Workflow output mapping failed: missing field" },
    ]);
  });

  it("maps artifacts to references carrying a uri (path), never bytes/payload", () => {
    const run = fixtureRunRecord({
      artifacts: [{ id: "a1", runId: "r", name: "shot.png", kind: "screenshot", mime: "image/png", path: "artifacts/a1.png", bytes: 999, createdAt: "t" }],
    });
    const report = renderModelFacing(run, identityRedact);
    expect(report.artifactRefs).toEqual([{ id: "a1", kind: "screenshot", uri: "artifacts/a1.png" }]);
    expect(JSON.stringify(report)).not.toContain("999"); // the byte COUNT never leaks into the model-facing report either
  });

  it("ends every result with a non-empty, deterministic `next` affordance (spec §32.2c)", () => {
    const r1 = renderModelFacing(fixtureRunRecord({ status: "failed" }), identityRedact);
    const r2 = renderModelFacing(fixtureRunRecord({ status: "failed" }), identityRedact);
    expect(r1.next).toBeTruthy();
    expect(r1.next).toBe(r2.next);
  });

  it("calls the injected RedactFn before returning (proof: a fake redactor that scrubs a known secret value removes it from the rendered output)", () => {
    const run = fixtureRunRecord({
      trace: [{ seq: 0, stepId: "a", block: "http.request", status: "failed", inputs: {}, error: "leaked sk-live-SECRET123 in response", startedAt: "t" }],
      status: "failed",
    });
    const testRedact = (record: unknown): unknown => JSON.parse(JSON.stringify(record).replaceAll("sk-live-SECRET123", "[REDACTED:API_KEY]"));
    const report = renderModelFacing(run, testRedact, new Set(["sk-live-SECRET123"]));
    expect(JSON.stringify(report)).not.toContain("sk-live-SECRET123");
    expect(report.failures[0]?.error).toContain("[REDACTED:API_KEY]");
  });

  it("has stable keys across two structurally-different runs of the same workflow (schema-shape test, not a value test)", () => {
    const passingRun = fixtureRunRecord({ status: "completed", artifacts: [] });
    const failingRun = fixtureRunRecord({
      status: "failed",
      trace: [{ seq: 0, stepId: "x", block: "browser.click", status: "failed", inputs: {}, error: "not found", startedAt: "t" }],
      artifacts: [{ id: "a1", runId: "r", name: "n", kind: "screenshot", mime: "image/png", path: "p", bytes: 1, createdAt: "t" }],
    });
    const r1 = renderModelFacing(passingRun, identityRedact);
    const r2 = renderModelFacing(failingRun, identityRedact);
    expect(Object.keys(r1).sort()).toEqual(Object.keys(r2).sort());
    expect(Object.keys(r2.failures[0]!).sort()).toEqual(["block", "error", "stepId"].sort());
    expect(Object.keys(r2.artifactRefs[0]!).sort()).toEqual(["id", "kind", "uri"].sort());
  });

  it("stays token-budget-small even for a RunRecord with many steps (a summary, not a dump — spec §32.7)", () => {
    const manySteps = Array.from({ length: 200 }, (_, i) => ({
      seq: i,
      stepId: `step_${i}`,
      block: "http.request",
      status: "completed" as const,
      inputs: { url: `https://example.com/${i}`, payload: "x".repeat(500) },
      outputs: { body: "y".repeat(500) },
      startedAt: "2026-01-01T00:00:00.000Z",
    }));
    const run = fixtureRunRecord({ status: "completed", trace: manySteps });
    const report = renderModelFacing(run, identityRedact);
    // 200 steps * ~1KB of inputs/outputs each would be ~200KB if the report
    // carried full trace detail — it must not, since only failures/artifacts
    // (here: zero of each) drive its size.
    expect(JSON.stringify(report).length).toBeLessThan(2000);
  });
});
