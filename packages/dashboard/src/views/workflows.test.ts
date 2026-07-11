import { describe, expect, it } from "vitest";
import { createTestFixture, makeRun, makeWorkflow } from "../test-support/fixtures.js";
import { renderRiskDiffPage, renderWorkflowDetailPage, renderWorkflowsListPage } from "./workflows.js";

describe("renderWorkflowsListPage / renderWorkflowDetailPage", () => {
  it("lists workflow ids with links", () => {
    expect(renderWorkflowsListPage(["wf-1", "wf-2"])).toContain('<a href="/workflows/wf-1">wf-1</a>');
  });

  it("renders gates, approval state, and action forms", () => {
    const html = renderWorkflowDetailPage(makeWorkflow({ id: "wf-1", approval: "draft" }), ["1.0.0"], []);
    expect(html).toContain("draft");
    expect(html).toContain('action="/workflows/wf-1/approve"');
    expect(html).toContain('action="/workflows/wf-1/promote"');
    expect(html).toContain('action="/workflows/wf-1/risk-diff"');
  });

  // root AMENDMENTS.md A43: the detail page previously showed neither
  // version history nor run history at all.
  it("renders version history newest-first, links every OTHER version back to this page with ?version=, and marks (not links) the one currently being viewed", () => {
    const html = renderWorkflowDetailPage(makeWorkflow({ id: "wf-1", version: "2.0.0" }), ["1.0.0", "2.0.0", "3.0.0"], []);
    expect(html.indexOf("version=3.0.0")).toBeLessThan(html.indexOf("(viewing)"));
    expect(html.indexOf("(viewing)")).toBeLessThan(html.indexOf("version=1.0.0"));
    expect(html).toContain('<a href="/workflows/wf-1?version=1.0.0">1.0.0</a>');
    expect(html).toContain('<a href="/workflows/wf-1?version=3.0.0">3.0.0</a>');
    expect(html).toContain("<strong>2.0.0</strong> (viewing)");
    expect(html).not.toContain('href="/workflows/wf-1?version=2.0.0"'); // the currently-viewed version isn't a link to itself
  });

  it("renders recent runs newest-first, each linking to its run detail page; an honest empty state when there are none", () => {
    const empty = renderWorkflowDetailPage(makeWorkflow({ id: "wf-1" }), ["1.0.0"], []);
    expect(empty).toContain("No runs yet.");

    const older = makeRun({ runId: "run-older", workflowId: "wf-1", startedAt: "2026-07-01T00:00:00.000Z" });
    const newer = makeRun({ runId: "run-newer", workflowId: "wf-1", startedAt: "2026-07-09T00:00:00.000Z" });
    const html = renderWorkflowDetailPage(makeWorkflow({ id: "wf-1" }), ["1.0.0"], [older, newer]);
    expect(html.indexOf("run-newer")).toBeLessThan(html.indexOf("run-older"));
    expect(html).toContain('<a href="/runs/run-newer">run-newer</a>');
  });
});

describe("deps.semanticRiskDiff / renderRiskDiffPage — real @aart/governance risk diff (S9 integration, reconciliation ledger item 13)", () => {
  it("a real capability-closure-based diff: added step, new capability, risk tier surfaced", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const a = makeWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }] } });
      const b = makeWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }, { id: "s2", uses: "command.run" }] } });
      const diff = deps.semanticRiskDiff(a, b);
      expect(diff.added).toEqual([{ stepId: "s2", uses: "command.run" }]);
      expect(diff.removed).toEqual([]);
      // command.run's real manifest declares the "command" capability
      // (packages/blocks-core/src/command/run.ts) - proves this is genuinely
      // resolving against the real block catalog, not a structural stand-in
      // that only ever compares uses-string sets.
      expect(diff.newCapabilities).toContain("command");
      expect(diff.capabilityChanged).toBe(true);

      const html = renderRiskDiffPage("wf-1", "1.0.0", "2.0.0", diff);
      expect(html).toContain("command.run");
      expect(html).toContain("command");
    } finally {
      await cleanup();
    }
  });

  it("identical workflows produce a no-change diff", async () => {
    const { deps, cleanup } = await createTestFixture();
    try {
      const a = makeWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }] } });
      const b = makeWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }] } });
      const diff = deps.semanticRiskDiff(a, b);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.capabilityChanged).toBe(false);
      expect(diff.riskIncreased).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

// AMENDMENTS.md A47: `approveOrDeprecateAction`/`promoteAction` (formerly
// tested below) are deleted from this module — `server.ts`'s `POST
// /workflows/:id/approve`/`/promote` routes now call
// `api.approveOrDeprecateWorkflow`/`api.promoteWorkflow` directly, thin
// proxies to `packages/server/src/workflow-actions.ts`/`promotion.ts`'s
// real implementations (the latter tested in `packages/server/src/
// promotion.test.ts`, already covering the real `evaluatePromotionForEnvironment`
// exercise the deleted "end-to-end with the real stub" case here used to
// provide; `workflow-actions.test.ts` covers the former).
