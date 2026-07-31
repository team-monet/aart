/**
 * A/B harness for issue #11's product check: does a model reuse an existing
 * command when it is exposed through AART as often as when the same command
 * is exposed through a personal agent skill?
 *
 * This stays model-provider agnostic like the rest of familiarity-evals:
 * callers run the same prompt in two fresh sessions, once with the AART MCP
 * surface/instructions and once with the equivalent skill, then feed the raw
 * first response here. The scorer is deterministic and never asks an LLM to
 * judge another LLM.
 */
export interface ReuseDiscoveryTask {
  id: string;
  prompt: string;
  aartMarkers: string[];
  skillMarkers: string[];
  adHocMarkers: string[];
}

export interface ReuseDiscoveryResult {
  taskId: string;
  surface: "aart" | "skill";
  reusedExistingTool: boolean;
  builtAdHocReplacement: boolean;
}

export interface ReuseDiscoveryComparison {
  aartReuseRate: number;
  skillReuseRate: number;
  delta: number;
  aartDoesNotOverclaimParity: boolean;
}

export const REUSE_DISCOVERY_TASK_CATALOG: readonly ReuseDiscoveryTask[] = [
  {
    id: "wait-for-codex-review",
    prompt: "Wait for the current pull request's Codex review and report the terminal review outcome.",
    aartMarkers: ["aart_find_tools", "aart find-tools", "aart_check_tool", "aart tool check"],
    skillMarkers: ["watch-codex-review", "watch-reviews"],
    adHocMarkers: ["while true", "gh api graphql", "sleep 30", "polling script"],
  },
];

function includesAny(rawOutput: string, markers: readonly string[]): boolean {
  const normalized = rawOutput.toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

export function scoreReuseDiscovery(
  task: ReuseDiscoveryTask,
  surface: "aart" | "skill",
  rawOutput: string,
): ReuseDiscoveryResult {
  const surfaceMarkers = surface === "aart" ? task.aartMarkers : task.skillMarkers;
  return {
    taskId: task.id,
    surface,
    reusedExistingTool: includesAny(rawOutput, surfaceMarkers),
    builtAdHocReplacement: includesAny(rawOutput, task.adHocMarkers),
  };
}

export function compareReuseDiscovery(
  aart: readonly ReuseDiscoveryResult[],
  skill: readonly ReuseDiscoveryResult[],
): ReuseDiscoveryComparison {
  const reuseRate = (results: readonly ReuseDiscoveryResult[]) =>
    results.length === 0 ? 0 : results.filter((result) => result.reusedExistingTool && !result.builtAdHocReplacement).length / results.length;
  const aartReuseRate = reuseRate(aart);
  const skillReuseRate = reuseRate(skill);
  return {
    aartReuseRate,
    skillReuseRate,
    delta: aartReuseRate - skillReuseRate,
    // AART may claim parity only when the measured rate actually reaches
    // the equivalent skill. A tool existing in listTools is not evidence.
    aartDoesNotOverclaimParity: aartReuseRate >= skillReuseRate,
  };
}
