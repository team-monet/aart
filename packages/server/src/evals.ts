// createEvalSuite / runEvalSuiteForWorkflow — the "Create suite" / "Run
// eval" write actions (architecture §13.2's v2 writable-action list) the
// dashboard's Evals page posts.
import type { AartStore } from "@aart/store";
import type { EvalExample, EvalRun, EvalSuite, Scorer } from "@aart/types";
import { createScorerRegistry, runEvalSuite } from "@aart/evidence";
import { generateId } from "./ids.js";

export interface CreateEvalSuiteInput {
  name: string;
  description?: string;
  scorer: Scorer;
  examples?: EvalExample[];
  tags?: string[];
}

/** Trivial store glue (no policy logic) — mirrors the now-deleted dashboard-local `createEvalSuite` (`packages/dashboard/src/stub-deps.ts`, pre-A47) exactly, moved here so this package's own real HTTP write path is the one implementation. */
export async function createEvalSuite(store: AartStore, input: CreateEvalSuiteInput): Promise<EvalSuite> {
  const suite: EvalSuite = {
    id: generateId("evalsuite"),
    name: input.name,
    description: input.description,
    examples: input.examples ?? [],
    scorer: input.scorer,
    tags: input.tags ?? [],
  };
  await store.evals.putSuite(suite);
  for (const example of suite.examples) {
    await store.evals.putExample(example);
  }
  return suite;
}

/**
 * No real `@aart/engine` execution wired — matches this codebase's own
 * established, explicitly-documented scope boundary for this specific seam
 * (`TEST-DRIVE.md`'s "What doesn't work yet": "trigger a run... still local
 * mirrors pending their own composition-root wiring pass" applies equally
 * to an eval example's own execute step, which IS a form of triggering a
 * run — `packages/mcp/src/real-context.ts`'s real `runEval` wires a genuine
 * `engine.triggerRun`+`executeRun` per example; doing the same here is a
 * separate, heavier, not-yet-scoped integration, not the store-access bug
 * this session targets — see this session's AMENDMENTS.md entry). Echoes
 * `input` back untouched, exactly matching the pre-A47 dashboard-local
 * stub's own behavior byte-for-byte: this session relocates WHERE the store
 * access happens, not what the eval run computes.
 */
function echoExecute(input: unknown): unknown {
  return input;
}

export type RunEvalSuiteForWorkflowResult =
  | { kind: "suite_not_found" }
  | { kind: "workflow_not_found" }
  | { kind: "ok"; evalRun: EvalRun; results: Array<{ exampleId: string; actual: unknown; result: { passed: boolean; score: number; detail?: string } }> };

/**
 * Runs `suiteId` against `workflowId`@`workflowVersion` (latest if
 * `workflowVersion` omitted, matching `aart_run_eval`'s own optional-version
 * convention) using `@aart/evidence`'s REAL 12-kind scorer registry +
 * run-suite algorithm (`createScorerRegistry`/`runEvalSuite` — not a
 * re-derived local stub of either, unlike the pre-A47 dashboard-local
 * mirror this replaces). Reads a suite's examples the same way
 * `packages/mcp/src/handlers/evals.ts`'s real `runEvalHandler` does: the
 * separately-queryable `store.evals.listExamples(suiteId)` collection is
 * authoritative when non-empty, falling back to the suite's own embedded
 * `examples` otherwise (a suite authored with inline examples and never
 * grown via the eval-example-from-correction flow) — the pre-A47
 * dashboard-local mirror read only the embedded array, silently missing any
 * example added later via that flow; this closes that gap for free while
 * fixing the actual store-divergence bug this session targets. Also
 * verifies the target workflow version actually exists (the pre-A47
 * dashboard action never checked, silently persisting an EvalRun against an
 * unvalidated workflowId/Version) — a store-correctness fix in the same
 * spirit, not a new feature. Persists the resulting EvalRun.
 */
export async function runEvalSuiteForWorkflow(store: AartStore, suiteId: string, workflowId: string, workflowVersion?: string): Promise<RunEvalSuiteForWorkflowResult> {
  const suite = await store.evals.getSuite(suiteId);
  if (!suite) return { kind: "suite_not_found" };

  const workflow = workflowVersion ? await store.workflows.get(workflowId, workflowVersion) : await store.workflows.getLatest(workflowId);
  if (!workflow) return { kind: "workflow_not_found" };

  const storedExamples = await store.evals.listExamples(suiteId);
  const effectiveSuite: EvalSuite = { ...suite, examples: storedExamples.length > 0 ? storedExamples : suite.examples };

  const scorers = createScorerRegistry();
  const result = await runEvalSuite(effectiveSuite, {
    execute: echoExecute,
    scorers,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    reportArtifact: generateId("evalreport"),
  });
  await store.evals.putRun(result.evalRun);
  return { kind: "ok", evalRun: result.evalRun, results: result.results };
}
