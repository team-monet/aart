// eval.run — spec §15.3 Eval group: aggregates a full EvalSuite's worth of
// scoring into one EvalRun record, versus eval.score (eval/score.ts), which
// scores a single actual/expected pair. Same FACTORY / DI pattern as
// eval.score — see that file's module doc comment for the full
// injected -> real @aart/evidence -> throw resolution order (no local
// fallback; scorer correctness is S6-owned business logic, not something
// this package reimplements) and for why capability `llm` is declared
// defensively (the `llm_judge` scorer kind genuinely invokes an LLM under
// the hood, and `kind` is a runtime input this manifest can't see ahead of
// time). Capability `file.write` is added here (absent from eval.score)
// because this block also writes the EvalRun itself as a report artifact
// via `ctx.writeArtifact`, matching artifact.write's `file.write` pairing
// (spec §31.1).
//
// Scope decision — `actuals` is caller-provided, not computed here: this
// block has no way to EXECUTE a target workflow against each of the
// suite's examples (BlockExecutionContext exposes no workflow-invocation
// capability, and orchestrating that — e.g. a forEach over the suite's
// examples invoking the target workflow per example — is @aart/engine's
// job, entirely out of a single block's reach). So the calling workflow is
// responsible for having already produced each example's actual output
// before this step runs (keyed by EvalExample.id in the `actuals` record);
// this block's job is strictly the aggregate SCORING step over the suite's
// examples plus those already-produced actuals.
//
// `regressions`/`improvements` are always empty here — computing either
// requires diffing against a PRIOR EvalRun, i.e. store-level history this
// block has no access to (BlockExecutionContext exposes no store/history
// read). A future consumer with real store access (e.g. @aart/evidence or
// a dashboard) is where that diff belongs; documented here rather than
// silently left unclear. `status` is likewise about whether THIS eval.run
// step finished executing (it always does here — the only failure mode,
// no ScorerRegistryPort resolvable, throws before an EvalRun is ever
// constructed), not whether the evaluated suite passed — that verdict is
// what total/passed/failed/score already convey.
import { z } from "zod";
import { EvalSuiteSchema, EvalRunSchema } from "@aart/types";
import { defineBlock } from "../lib/define-block.js";
import { ScorerRegistryUnavailableError, tryLoadEvidenceScorerRegistry, type ScorerRegistryPort } from "./scorer-registry-port.js";

const inputSchema = z.object({
  suite: EvalSuiteSchema,
  actuals: z
    .record(z.string(), z.unknown())
    .describe("Keyed by EvalExample.id — the target workflow's already-produced actual output for each example."),
  workflowId: z.string().optional(),
  workflowVersion: z.string().optional(),
});
const outputSchema = EvalRunSchema;

export function createEvalRunBlock(scorerRegistry?: ScorerRegistryPort) {
  return defineBlock({
    id: "eval.run",
    capabilities: ["file.write", "llm"],
    category: "eval",
    description:
      'Scores an entire EvalSuite against already-produced actual outputs and persists the result as a report artifact. Example: suite: "{{ steps.load_suite.outputs.suite }}", actuals: "{{ steps.run_examples.outputs.actualsById }}". Returns the aggregate EvalRun (total/passed/failed/score) with reportArtifact set to the written artifact\'s id.',
    inputSchema,
    outputSchema,
    execute: async (input, ctx) => {
      const registry = scorerRegistry ?? (await tryLoadEvidenceScorerRegistry());
      if (!registry) throw new ScorerRegistryUnavailableError("eval.run");

      let passed = 0;
      let totalScore = 0;
      for (const example of input.suite.examples) {
        const actual = input.actuals[example.id];
        const result = await registry.score(
          input.suite.scorer.kind,
          actual,
          example.expected,
          example.scorerConfig ?? input.suite.scorer.config,
        );
        if (result.passed) passed++;
        totalScore += result.score;
      }
      const total = input.suite.examples.length;
      const failed = total - passed;
      const score = total > 0 ? totalScore / total : 0;

      const evalRun = {
        id: `eval-run-${ctx.runId}-${ctx.stepId}`,
        suiteId: input.suite.id,
        workflowId: input.workflowId ?? "",
        workflowVersion: input.workflowVersion ?? "",
        status: "completed" as const,
        total,
        passed,
        failed,
        score,
        // See module doc comment: diffing against prior-run history is out
        // of a block's reach, always empty here.
        regressions: [] as string[],
        improvements: [] as string[],
        reportArtifact: "", // filled in below, once the artifact is written
      };

      const bytes = new TextEncoder().encode(JSON.stringify(evalRun));
      const written = await ctx.writeArtifact({
        name: `${evalRun.id}.json`,
        kind: "json_output",
        mime: "application/json",
        bytes,
      });
      return { ...evalRun, reportArtifact: written.id };
    },
  });
}

/** The default catalog member — lazily resolves the real `@aart/evidence` registry at call time, no injection required. */
export const evalRunBlock = createEvalRunBlock();
