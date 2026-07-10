// improvement-brief.ts — architecture §9.7: ImprovementBrief generation
// (spec §25.2).
import type { AartStore } from "@aart/store";
import type { Correction, ImprovementBrief } from "@aart/types";
import { correctionKey } from "./corrections/correction.js";

export interface GenerateImprovementBriefOptions {
  /** A configurable per-workflow policy list (architecture §9.7) — e.g. the spec's own example: "preserve existing passing evals," "pricing calculations must remain deterministic" for the energy domain. Neither store member nor spec field holds this, so it's caller-supplied. */
  constraints?: string[];
}

/**
 * Generates an ImprovementBrief by walking failed EvalExamples for the
 * version plus any Corrections not yet referenced by any EvalExample (via
 * `eval_examples.created_from_correction` — architecture §9.7: "the
 * predicate direction matters" — `createdFromCorrection` lives on
 * EvalExample, NOT on Correction, so the predicate is "does any EvalExample
 * reference this correction," never "is this correction's own field
 * unset").
 *
 * Two store-shape notes worth being explicit about (neither is a gap this
 * function papers over — both are genuine absences in the frozen types):
 *
 * 1. EvalExample carries no workflowId/workflowVersion of its own — only
 *    EvalRun does. "Failed eval examples for the version" is therefore read
 *    as: every `EvalRun.regressions` entry (this run's list of failed
 *    example ids — see run-suite.ts's doc comment for why `regressions` is
 *    read this way) across every EvalRun recorded for (workflowId,
 *    workflowVersion).
 * 2. Correction carries no workflowId/workflowVersion of its own either —
 *    only runId/stepId/fieldPath (architecture §5.3's corrections table).
 *    "Corrections that reference this workflow version" is read as:
 *    corrections attached to any run belonging to (workflowId,
 *    workflowVersion), found by joining through RunStore.
 */
export async function generateImprovementBrief(
  store: AartStore,
  workflowId: string,
  workflowVersion: string,
  options: GenerateImprovementBriefOptions = {},
): Promise<ImprovementBrief> {
  const evalRuns = await store.evals.listRuns({ workflowId });
  const runsForVersion = evalRuns.filter((r) => r.workflowVersion === workflowVersion);
  const failedEvalIds = Array.from(new Set(runsForVersion.flatMap((r) => r.regressions)));

  const runs = await store.runs.list({ workflowId });
  const runIdsForVersion = new Set(runs.filter((r) => r.workflowVersion === workflowVersion).map((r) => r.runId));
  const allCorrections: Correction[] = [];
  for (const runId of runIdsForVersion) {
    allCorrections.push(...(await store.corrections.list({ runId })));
  }

  const suites = await store.evals.listSuites();
  const referencedKeys = new Set<string>();
  for (const suite of suites) {
    const examples = await store.evals.listExamples(suite.id);
    for (const example of examples) {
      if (example.createdFromCorrection) referencedKeys.add(example.createdFromCorrection);
    }
  }
  const unreferencedCorrections = allCorrections.filter((c) => !referencedKeys.has(correctionKey(c)));

  const totalProblems = failedEvalIds.length;
  return {
    workflowId,
    workflowVersion,
    problemSummary: `failed ${totalProblems} eval example${totalProblems === 1 ? "" : "s"}`,
    failedEvalIds,
    corrections: unreferencedCorrections.map((c) => ({ summary: c.reason, sourceRunId: c.runId, fieldPath: c.fieldPath })),
    constraints: options.constraints ?? [],
  };
}

/**
 * Renders an ImprovementBrief into the literal text format spec §25.2's
 * worked example shows. Tested directly against that example as a fixture
 * (this session's DoD: "test the ImprovementBrief against spec §25.2's
 * rendered example — that one IS a literal fixture").
 */
export function renderImprovementBrief(brief: ImprovementBrief): string {
  const lines: string[] = [];
  lines.push(`Workflow: ${brief.workflowId}@${brief.workflowVersion}`);
  lines.push(`Problem: ${brief.problemSummary}`);
  lines.push("Corrections:");
  for (const c of brief.corrections) lines.push(`- ${c.summary}`);
  lines.push("");
  lines.push("Please propose a new workflow/block version.");
  lines.push("Constraints:");
  for (const c of brief.constraints) lines.push(`- ${c}`);
  return lines.join("\n");
}
