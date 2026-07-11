import { describe, expect, it } from "vitest";
import { makeRun } from "../test-support/fixtures.js";
import { formatAge, listRunsFilterFromQuery, renderArtifactsPage, renderRunDetailPage, renderRunsListPage, renderWaitingRunsPage } from "./runs.js";

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

// AMENDMENTS.md A47: `triggerWorkflowAction` (formerly tested below) is
// deleted from this module — `server.ts`'s `POST /runs/trigger` route now
// calls `api.triggerRun` directly, a thin proxy to
// `packages/server/src/http/server.ts`'s new `/runs/trigger` endpoint
// (tested in `packages/server/src/http/server.test.ts`'s "trigger a
// workflow run" describe block, and in `api-client.test.ts` for both the
// HTTP and fake-store-backed `ApiClient` implementations).
