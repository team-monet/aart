import { describe, expect, it } from "vitest";
import { createTestFixture, makeRun, makeWorkflow } from "../test-support/fixtures.js";
import { formatAge, listRunsFilterFromQuery, renderArtifactsPage, renderRunDetailPage, renderRunsListPage, renderWaitingRunsPage, triggerWorkflowAction } from "./runs.js";

describe("renderRunsListPage", () => {
  it("lists runs with a link per run and surfaces an unresolved flag", () => {
    const html = renderRunsListPage([makeRun({ runId: "run-1", status: "completed" }), makeRun({ runId: "run-2", status: "failed", flag: { kind: "poison", flaggedAt: "t" } })]);
    expect(html).toContain('<a href="/runs/run-1">run-1</a>');
    expect(html).toContain("poison");
  });
});

describe("renderRunDetailPage", () => {
  it("embeds the pre-rendered report HTML (S6 renderer output, not a re-implemented transform)", () => {
    const html = renderRunDetailPage(makeRun({ runId: "run-1" }), '<section data-run-id="run-1">from renderer</section>');
    expect(html).toContain("from renderer");
  });
});

describe("renderArtifactsPage", () => {
  it("aggregates artifacts across every run", () => {
    const runWithArtifact = makeRun({
      runId: "run-a",
      artifacts: [{ id: "art-1", runId: "run-a", name: "screenshot.png", kind: "screenshot", mime: "image/png", path: "artifacts/art-1.png", bytes: 100, createdAt: "t" }],
    });
    const html = renderArtifactsPage([runWithArtifact, makeRun({ runId: "run-b" })]);
    expect(html).toContain("screenshot.png");
    expect(html).toContain("run-a");
  });
});

describe("formatAge", () => {
  it.each([
    [500, "0s"],
    [45_000, "45s"],
    [5 * 60_000, "5m"],
    [3 * 60 * 60_000, "3h"],
    [2 * 24 * 60 * 60_000, "2d"],
  ])("formats %dms as %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});

describe("renderWaitingRunsPage", () => {
  it("surfaces wait age (staleness visibility, architecture §4.4.1)", () => {
    const now = new Date("2026-07-10T03:00:00.000Z");
    const html = renderWaitingRunsPage([{ runId: "run-1", stepId: "step1", wait: { type: "signal", name: "n", correlationId: "c", schemaVersion: 1 }, createdAt: "2026-07-10T00:00:00.000Z" }], now);
    expect(html).toContain("3h");
    expect(html).toContain("signal");
  });
});

describe("listRunsFilterFromQuery", () => {
  it("extracts status/workflowId from a query string, omitting absent keys", () => {
    expect(listRunsFilterFromQuery(new URLSearchParams("status=failed"))).toEqual({ status: "failed" });
    expect(listRunsFilterFromQuery(new URLSearchParams(""))).toEqual({});
  });
});

describe("triggerWorkflowAction", () => {
  it("resolves the Workflow from the store and delegates to the injected triggerRun (S1's bound Engine.triggerRun shape)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      const workflow = makeWorkflow({ id: "wf-trig", version: "1.0.0" });
      await store.workflows.put(workflow);

      const run = await triggerWorkflowAction(deps, store, { workflowId: "wf-trig", workflowVersion: "1.0.0", inputs: { x: 1 } });

      expect(run.workflowId).toBe("wf-trig");
      expect(run.status).toBe("pending");
      expect(await store.runs.get(run.runId)).toEqual(run);
    } finally {
      await cleanup();
    }
  });

  it("throws for an unknown workflow rather than silently triggering nothing", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await expect(triggerWorkflowAction(deps, store, { workflowId: "nope", workflowVersion: "1.0.0", inputs: {} })).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
