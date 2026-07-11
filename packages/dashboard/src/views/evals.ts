// Eval dashboards (v3) + create eval / run eval (v2 writable actions —
// architecture §13.2). Suites/runs read via `ApiClient.listEvals` (`GET
// /evals`, AMENDMENTS.md A47 — previously a direct `store.evals.listSuites`/
// `listRuns` read, the same store-divergence bug class root AMENDMENTS.md
// A43 fixed for workflow/block detail).
//
// AMENDMENTS.md A47: `createEvalAction`/`runEvalAction` (formerly here) are
// deleted — `server.ts`'s `POST /evals/suites`/`POST /evals/runs` routes
// now call `api.createEvalSuite`/`api.runEvalSuite` directly, thin proxies
// to `packages/server/src/evals.ts`'s real implementations (the latter
// backed by `@aart/evidence`'s real 12-kind scorer registry, not this
// package's own former 1-kind stub).
import type { EvalRun, EvalSuite } from "@aart/types";
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
