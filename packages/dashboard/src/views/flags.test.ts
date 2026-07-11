import { describe, expect, it } from "vitest";
import { makeRun } from "../test-support/fixtures.js";
import { renderFlaggedRunsPage } from "./flags.js";

// AMENDMENTS.md A47: `clearFlagAction` (formerly tested below) is deleted
// from this module — `server.ts`'s `POST /flagged-runs/:runId/clear` route
// now calls `api.clearRunFlag` directly, a thin proxy to `@aart/server`'s
// own already-real `POST /runs/:runId/flag/clear` endpoint (that endpoint,
// and the `clearRunFlag`/`listFlaggedRuns` functions behind it, were
// ALREADY real and already tested in `packages/server`; only this
// package's own store-direct call site needed fixing — see
// `api-client.test.ts`'s new `clearRunFlag` coverage for both the HTTP and
// fake-store-backed implementations this file's action used to stand in
// for).
describe("renderFlaggedRunsPage", () => {
  it("renders a clear-flag form for each flagged run", () => {
    const html = renderFlaggedRunsPage([makeRun({ runId: "run-1", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } })]);
    expect(html).toContain("run-1");
    expect(html).toContain("poison");
    expect(html).toContain('action="/flagged-runs/run-1/clear"');
  });

  it("escapes run ids/flag kinds when rendering (no raw HTML injection from store data)", () => {
    const html = renderFlaggedRunsPage([makeRun({ runId: '<img src=x onerror=alert(1)>', status: "failed", flag: { kind: "poison", flaggedAt: "t" } })]);
    expect(html).not.toContain("<img src=x");
  });
});
