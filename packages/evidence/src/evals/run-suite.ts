// run-suite.ts — runs an EvalSuite's examples through the scorer registry
// (spec §24.1/§24.4), producing an EvalRun. Decoupled from HOW `actual` is
// produced from an example's `input` (`options.execute`) — a caller
// supplies that (e.g. wiring it to `runStepsWithDryRun` for an offline
// fixture-workflow suite, as this package's own tests do, or to a real
// @aart/engine trigger-and-wait-for-completion call once that integration
// exists — out of this package's scope, see report). This is exactly what
// lets `@aart/blocks-core`'s `eval.run` block (S3) call into this function
// without @aart/evidence needing to depend on @aart/engine/@aart/blocks-core.
import type { EvalExample, EvalRun, EvalSuite, Scorer } from "@aart/types";
import type { ScorerRegistry } from "./scorers/registry.js";
import type { ScorerResult } from "./scorers/types.js";

export interface EvalExampleResult {
  exampleId: string;
  actual: unknown;
  result: ScorerResult;
}

export interface RunEvalExampleOptions {
  dryRun?: boolean;
  execute: (input: unknown, ctx: { dryRun: boolean }) => unknown | Promise<unknown>;
  scorers: ScorerRegistry;
}

/** Runs one EvalExample: produces `actual` via `options.execute`, scores it against `example.expected` with `scorer`. `example.scorerConfig` takes precedence over `scorer.config` when both are present (an example-level override of the suite's default scorer config). */
export async function runEvalExample(example: EvalExample, scorer: Pick<Scorer, "kind" | "config">, options: RunEvalExampleOptions): Promise<EvalExampleResult> {
  const dryRun = options.dryRun ?? false;
  const actual = await options.execute(example.input, { dryRun });
  const result = await options.scorers.score(scorer.kind, actual, example.expected, example.scorerConfig ?? scorer.config);
  return { exampleId: example.id, actual, result };
}

export interface RunEvalSuiteOptions extends RunEvalExampleOptions {
  workflowId: string;
  workflowVersion: string;
  /** EvalRun.reportArtifact (spec §24.4) is a required field — the id/pointer of a written report artifact. This function does not write one itself (it has no ArtifactStore access); callers that want a real artifact write it separately and pass its id here. */
  reportArtifact: string;
}

export interface RunEvalSuiteResult {
  evalRun: EvalRun;
  results: EvalExampleResult[];
}

/**
 * Runs every example in `suite` and aggregates an EvalRun (spec §24.4).
 * `score` is the average of each example's own `.score` (not just the
 * pass/fail rate) — this lets graded scorers like field_level_accuracy
 * meaningfully move the aggregate even when `passed` is binary.
 * `regressions` is this run's list of FAILED example ids (see
 * improvement-brief.ts's doc comment for why this is the field
 * generateImprovementBrief reads as "failed eval example ids" — EvalRun has
 * no other per-example pass/fail list). `improvements` is always `[]`:
 * computing it requires diffing against a PRIOR EvalRun for the same
 * suite+workflow, which is out of this function's scope (a natural
 * extension point for a caller that has that history) — see report.
 */
export async function runEvalSuite(suite: EvalSuite, options: RunEvalSuiteOptions): Promise<RunEvalSuiteResult> {
  const results: EvalExampleResult[] = [];
  for (const example of suite.examples) {
    results.push(await runEvalExample(example, suite.scorer, options));
  }

  const total = results.length;
  const passed = results.filter((r) => r.result.passed).length;
  const failed = total - passed;
  const score = total === 0 ? 1 : results.reduce((sum, r) => sum + r.result.score, 0) / total;
  const regressions = results.filter((r) => !r.result.passed).map((r) => r.exampleId);

  const evalRun: EvalRun = {
    id: `evalrun_${suite.id}_${Date.now()}`,
    suiteId: suite.id,
    workflowId: options.workflowId,
    workflowVersion: options.workflowVersion,
    status: "completed",
    total,
    passed,
    failed,
    score,
    regressions,
    improvements: [],
    reportArtifact: options.reportArtifact,
  };

  return { evalRun, results };
}
