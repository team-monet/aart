import { describe, expect, it } from "vitest";
import type { ApproveOrDeprecateWorkflowFn, PromoteResult, PromoteWorkflowVersionToEnvironmentFn } from "../deps.js";
import { createTestFixture, makeEnvironment, makeWorkflow } from "../test-support/fixtures.js";
import { approveOrDeprecateAction, promoteAction, renderRiskDiffPage, renderWorkflowDetailPage, renderWorkflowsListPage } from "./workflows.js";

describe("renderWorkflowsListPage / renderWorkflowDetailPage", () => {
  it("lists workflow ids with links", () => {
    expect(renderWorkflowsListPage(["wf-1", "wf-2"])).toContain('<a href="/workflows/wf-1">wf-1</a>');
  });

  it("renders gates, approval state, and action forms", () => {
    const html = renderWorkflowDetailPage(makeWorkflow({ id: "wf-1", approval: "draft" }));
    expect(html).toContain("draft");
    expect(html).toContain('action="/workflows/wf-1/approve"');
    expect(html).toContain('action="/workflows/wf-1/promote"');
    expect(html).toContain('action="/workflows/wf-1/risk-diff"');
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

describe("approveOrDeprecateAction — same-function-reference proof", () => {
  it("calls the injected approveOrDeprecateWorkflow with the resolved requiredGatesForMode for the given trust mode", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-a", version: "1.0.0" }));
      const calls: unknown[] = [];
      const spy: ApproveOrDeprecateWorkflowFn = async (s, workflowId, version, action, requiredGatesForMode) => {
        calls.push({ workflowId, version, action, requiredGatesForMode });
        return (await s.workflows.get(workflowId, version))!;
      };

      await approveOrDeprecateAction({ ...deps, approveOrDeprecateWorkflow: spy }, store, "wf-a", "1.0.0", "approve", "governed");

      expect(calls).toEqual([{ workflowId: "wf-a", version: "1.0.0", action: "approve", requiredGatesForMode: deps.requiredGatesByTrustMode["governed"] }]);
    } finally {
      await cleanup();
    }
  });
});

describe("promoteAction — same-function-reference proof", () => {
  it("calls the injected promoteWorkflowVersionToEnvironment with exactly the given params — the outer seam boundary architecture §13.2 cares about", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-p", version: "1.0.0", approval: "approved" }));
      await store.environments.put(makeEnvironment({ id: "env-1" }));

      const calls: unknown[] = [];
      const fakeResult: PromoteResult = { kind: "not_promoted", record: { environment: "env-1", promoted: false, globalApproval: "approved", requiredGates: [], unmetGates: [] } };
      const spy: PromoteWorkflowVersionToEnvironmentFn = async (_store, params) => {
        calls.push(params);
        return fakeResult;
      };

      const result = await promoteAction({ ...deps, promoteWorkflowVersionToEnvironment: spy }, store, "wf-p", "1.0.0", "env-1", { a: 1 });

      expect(calls).toEqual([{ workflowId: "wf-p", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: { a: 1 } }]);
      expect(result).toBe(fakeResult); // promoteAction returns exactly what the injected function returned — no re-shaping
    } finally {
      await cleanup();
    }
  });

  it("end-to-end with the real stub: promotes when gates are satisfied (exercises the real evaluatePromotionForEnvironment internally)", async () => {
    const { store, deps, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-real", version: "1.0.0", approval: "approved" }));
      await store.environments.put(makeEnvironment({ id: "env-real", config: { trustMode: "dev" } }));

      const result = await promoteAction(deps, store, "wf-real", "1.0.0", "env-real");

      expect(result.kind).toBe("promoted");
    } finally {
      await cleanup();
    }
  });
});
