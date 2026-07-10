// Eval dashboards (v3) + create eval / run eval (v2 writable actions —
// architecture §13.2). Suites/runs read directly from `store.evals` (no
// documented S2 HTTP route for listing them yet — same "no route published"
// situation as approvals/corrections, flagged in SEAMS.md).
import type { AartStore } from "@aart/store";
import type { EvalRun, EvalSuite, Scorer } from "@aart/types";
import type { DashboardDeps, RunEvalSuiteResult } from "../deps.js";
import { generateId } from "../ids.js";
import { escapeHtml, form, page, table, textField } from "../http/html.js";

export function renderEvalDashboardPage(suites: EvalSuite[], runs: EvalRun[]): string {
  const suiteRows = suites.map((s) => [escapeHtml(s.id), escapeHtml(s.name), `${s.examples.length}`, escapeHtml(s.scorer.kind)]);
  const runRows = runs.map((r) => [escapeHtml(r.id), escapeHtml(r.suiteId), escapeHtml(r.workflowId), escapeHtml(r.workflowVersion), escapeHtml(r.status), `${r.passed}/${r.total}`, r.score.toFixed(2)]);
  const body = `<h2>Suites</h2>
${table(["Id", "Name", "Examples", "Scorer"], suiteRows)}
<p><a href="/evals/new">Create a suite</a></p>
<h2>Runs</h2>
${table(["Id", "Suite", "Workflow", "Version", "Status", "Passed", "Score"], runRows)}`;
  return page("Evals", body);
}

export function renderCreateEvalFormPage(): string {
  const body = form(
    "/evals/suites",
    `${textField("name", "Name")}
${textField("description", "Description")}
${textField("scorerKind", "Scorer kind", "exact_match")}`,
    "Create suite",
  );
  return page("Create Eval Suite", body);
}

/** Thin delegate to the injected `createEvalSuite`. */
export async function createEvalAction(deps: DashboardDeps, store: AartStore, input: { name: string; description?: string; scorer: Scorer }): Promise<EvalSuite> {
  return deps.createEvalSuite(store, input);
}

/** No engine dependency — matches run-suite.ts's own documented decoupling of scoring from execution. A real engine-backed `execute` is S9 integration scope (same note as S6's own E5 familiarity-evals seam); kept local to this module (not stub-deps.ts) since it's part of the ACTION's own default wiring, not part of the DashboardDeps seam surface itself. */
function defaultExecute(input: unknown): unknown {
  return input;
}

/**
 * "Run eval": loads the suite, builds a scorer registry via the injected
 * `createScorerRegistry` (S6 seam E2), runs it via the injected
 * `runEvalSuite` (S6's run-suite.ts) with a default echo `execute`, and
 * persists the resulting EvalRun.
 */
export async function runEvalAction(deps: DashboardDeps, store: AartStore, suiteId: string, workflowId: string, workflowVersion: string): Promise<RunEvalSuiteResult> {
  const suite = await store.evals.getSuite(suiteId);
  if (!suite) throw new Error(`eval suite not found: ${suiteId}`);
  const scorers = deps.createScorerRegistry();
  const result = await deps.runEvalSuite(suite, { execute: defaultExecute, scorers, workflowId, workflowVersion, reportArtifact: generateId("evalreport") });
  await store.evals.putRun(result.evalRun);
  return result;
}
