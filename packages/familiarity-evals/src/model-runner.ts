// model-runner.ts — the fake-model adapter (this session's DoD: "a
// model-runner interface with a fake-model adapter (returns
// canned/scripted responses) so the suite runs fully offline").
import type { AuthoringTask, ModelAttemptResult, ModelRunner } from "./types.js";

export interface ScriptedResponse {
  rawOutput: string;
  workflow?: unknown;
}

/**
 * A fake ModelRunner returning canned/scripted responses keyed by task id.
 * `script[taskId]` may be a single ScriptedResponse (used for every round)
 * or an array (one entry per corrective round — the LAST entry repeats
 * once the array is exhausted), so a test can script "the model gets it
 * right on round 2" scenarios for loops-to-valid testing.
 */
export function createFakeModelRunner(script: Record<string, ScriptedResponse | ScriptedResponse[]>): ModelRunner {
  const callCounts = new Map<string, number>();
  return async (task: AuthoringTask): Promise<ModelAttemptResult> => {
    const entry = script[task.id];
    if (!entry) {
      throw new Error(`createFakeModelRunner: no scripted response for task "${task.id}"`);
    }
    const round = callCounts.get(task.id) ?? 0;
    callCounts.set(task.id, round + 1);
    const responses = Array.isArray(entry) ? entry : [entry];
    const response = responses[Math.min(round, responses.length - 1)]!;
    return { rawOutput: response.rawOutput, workflow: response.workflow };
  };
}
