// run-success.ts — see types.ts's RunSuccessFn doc comment for the
// @aart/engine-backed seam this is standing in for.
import { WorkflowSchema } from "@aart/types";
import type { RunSuccessFn, RunSuccessResult } from "./types.js";

/**
 * A lightweight REFERENCE run-success checker — NOT a real @aart/engine
 * execution (S1's scope; not a consumed interface of this package).
 * Deterministic stand-in: "succeeds" iff the candidate parses as a
 * Workflow AND has at least one step (an empty workflow can't meaningfully
 * "run"). S9 wires the real engine-backed check in later — see SEAMS.md.
 */
export function createReferenceRunSuccessChecker(): RunSuccessFn {
  return (workflow: unknown): RunSuccessResult => {
    const parsed = WorkflowSchema.safeParse(workflow);
    if (!parsed.success) return { succeeded: false, error: "workflow does not parse against WorkflowSchema" };
    if (parsed.data.execution.steps.length === 0) return { succeeded: false, error: "workflow has no steps" };
    return { succeeded: true };
  };
}
