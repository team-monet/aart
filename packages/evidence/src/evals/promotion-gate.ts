// promotion-gate.ts — architecture §9.6: "eval.run's result writes the
// evals gate (§7.1/§7.3)... writes 'passed' only if the EvalRun.score meets
// the minScore threshold declared in the workflow's promotion.requires[]
// .evals config (spec §24.5); otherwise writes 'failed'. This is the one
// gate whose pass/fail isn't binary-by-nature."
import type { AartStore } from "@aart/store";
import type { EvalRun, GateStatus, Workflow } from "@aart/types";

/** Pure threshold comparison — no store access. */
export function computeEvalsGateStatus(evalRun: EvalRun, minScore: number): GateStatus {
  return evalRun.score >= minScore ? "passed" : "failed";
}

/** Store-integrated wrapper: loads the target workflow version, writes its `gates.evals` field, persists, returns the updated Workflow. */
export async function applyEvalsGate(store: AartStore, workflowId: string, workflowVersion: string, evalRun: EvalRun, minScore: number): Promise<Workflow> {
  const workflow = await store.workflows.get(workflowId, workflowVersion);
  if (!workflow) {
    throw new Error(`applyEvalsGate: no such workflow "${workflowId}@${workflowVersion}"`);
  }
  const updated: Workflow = { ...workflow, gates: { ...workflow.gates, evals: computeEvalsGateStatus(evalRun, minScore) } };
  await store.workflows.put(updated);
  return updated;
}
