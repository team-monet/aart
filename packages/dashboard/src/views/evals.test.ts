import { describe, expect, it } from "vitest";
import { makeEvalSuite } from "../test-support/fixtures.js";
import { renderCreateEvalFormPage, renderEvalDashboardPage } from "./evals.js";

// AMENDMENTS.md A47: `createEvalAction`/`runEvalAction` (formerly tested
// below) are deleted from this module — `server.ts`'s `POST
// /evals/suites`/`POST /evals/runs` routes now call `api.createEvalSuite`/
// `api.runEvalSuite`, thin proxies to `packages/server/src/evals.ts`'s real
// implementations (tested there, including real-scorer-registry coverage
// this file's own "end-to-end with the real stub scorer registry" case
// used to provide against a 1-kind local stub — evals.ts now uses
// @aart/evidence's real 12-kind registry instead).
describe("renderEvalDashboardPage / renderCreateEvalFormPage", () => {
  it("renders suites and runs", () => {
    const html = renderEvalDashboardPage([makeEvalSuite({ id: "suite-1", name: "My Suite" })], [{ id: "run-1", suiteId: "suite-1", workflowId: "wf-1", workflowVersion: "1.0.0", status: "completed", total: 2, passed: 2, failed: 0, score: 1, regressions: [], improvements: [], reportArtifact: "a1" }]);
    expect(html).toContain("My Suite");
    expect(html).toContain("2/2");
  });

  it("renders a create-suite form", () => {
    expect(renderCreateEvalFormPage()).toContain('action="/evals/suites"');
  });
});
