// V1 event log foundation (AMENDMENTS.md A61), RISK 1 — this package's own
// createRealRunSuccessFn is the SECOND of exactly two real
// `createEngine(...)` composition roots in the workspace (the other:
// packages/mcp/src/real-context.ts's createRealEngine, already covered by
// that package's own real-context.test.ts). No test file previously
// existed for this module at all (run-success.test.ts only covers the
// lightweight reference checker, run-success.ts — NOT this real-engine one)
// — this is a focused, minimal test proving the onRunTerminal fix reaches
// this composition root too, not a full re-test of everything real-checks.ts
// does.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore, type AartStore } from "@aart/store";
import { createRealRunSuccessFn } from "./real-checks.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function freshStore(): Promise<AartStore> {
  root = await fs.mkdtemp(join(tmpdir(), "aart-familiarity-evals-real-checks-"));
  return createFsStore(root);
}

describe("createRealRunSuccessFn — onRunTerminal emits run.completed/failed (V1 event log foundation, AMENDMENTS.md A61, RISK 1)", () => {
  it("a succeeding candidate workflow emits run.completed", async () => {
    const store = await freshStore();
    const runSuccess = createRealRunSuccessFn(store);
    const workflow = {
      id: "familiarity-eval-completed-1",
      name: "Real run-success smoke test",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.noop", with: { value: 1 } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };

    const result = await runSuccess(workflow);
    expect(result.succeeded).toBe(true);

    const events = await store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", workflowId: workflow.id, workflowVersion: workflow.version }));
  });

  it("a failing candidate workflow (flow.fail) emits run.failed, not run.completed", async () => {
    const store = await freshStore();
    const runSuccess = createRealRunSuccessFn(store);
    const workflow = {
      id: "familiarity-eval-failed-1",
      name: "Real run-success failure smoke test",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.fail", with: { message: "intentional failure" } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };

    const result = await runSuccess(workflow);
    expect(result.succeeded).toBe(false);

    const events = await store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.failed", workflowId: workflow.id, workflowVersion: workflow.version }));
    expect(events.some((e) => e.type === "run.completed")).toBe(false);
  });
});
