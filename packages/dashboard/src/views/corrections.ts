// Correction queue (v3) + record correction + the 6 correction outcomes +
// 2 complements (v2/v3 writable actions — S6 seam E4, architecture §13.2).
//
// AMENDMENTS.md A47: every action that used to live here as a one-line
// `deps.X(store, ...)` delegate (`findCorrectionByKey`,
// `recordCorrectionAction`, `updateRunOutputAction`,
// `createEvalExampleFromCorrectionAction`, `createIssueForAgentAction`,
// `triggerImprovementProposalAction`, `blockPromotionAction`,
// `unblockPromotionAction`, `markNeedsReviewAction`,
// `clearNeedsReviewAction`) is deleted — `server.ts`'s routes now call the
// corresponding `ApiClient` method directly (matching how every v1 READ
// route already called `api.X()` with no view-file indirection), closing
// the store-divergence bug class (root AMENDMENTS.md A43) for these writes
// the same way it was already closed for reads. This file keeps only pure
// rendering + the `correctionKey` encoding both this file's own outcome
// buttons and `server.ts`'s `/corrections/:key/...` routes rely on.
import type { Correction } from "@aart/types";
import { escapeHtml, form, page, table, textField } from "../http/html.js";

/**
 * The stable identity of a Correction. Spec §23.3's `Correction` has no
 * `id` field of its own — architecture §5.3's `corrections` table
 * primary-keys on `(run_id, step_id, field_path)` instead (no
 * `created_at` component). This MATCHES `@aart/evidence`'s own published
 * convention exactly (`packages/evidence/src/corrections/correction.ts`'s
 * `correctionKey`, same `${runId}:${stepId}:${fieldPath}` format, no
 * timestamp) — kept as an identical local mirror (rather than importing
 * evidence's copy) since this is purely a URL-encoding concern for this
 * page's own links, not a store-touching operation.
 */
export function correctionKey(correction: Pick<Correction, "runId" | "stepId" | "fieldPath">): string {
  return `${correction.runId}:${correction.stepId}:${correction.fieldPath}`;
}

export function renderCorrectionQueuePage(corrections: Correction[]): string {
  const rows = corrections.map((c) => [
    `<a href="/runs/${escapeHtml(c.runId)}">${escapeHtml(c.runId)}</a>`,
    escapeHtml(c.stepId),
    escapeHtml(c.fieldPath),
    escapeHtml(JSON.stringify(c.observed)),
    escapeHtml(JSON.stringify(c.corrected)),
    escapeHtml(c.reason),
    escapeHtml(c.reviewer),
    outcomeButtons(c),
  ]);
  return page("Correction Queue", table(["Run", "Step", "Field", "Observed", "Corrected", "Reason", "Reviewer", "Outcomes"], rows));
}

function outcomeButtons(c: Correction): string {
  const key = encodeURIComponent(correctionKey(c));
  return `
<form method="post" action="/corrections/${key}/update-run-output"><button type="submit">Update run output</button></form>
<form method="post" action="/corrections/${key}/create-eval-example"><input type="text" name="suiteId" placeholder="suiteId"><button type="submit">Create eval example</button></form>
<form method="post" action="/corrections/${key}/create-issue"><button type="submit">Create issue for agent</button></form>`;
}

export function renderRecordCorrectionFormPage(runId = "", stepId = ""): string {
  const body = form(
    "/corrections",
    `${textField("runId", "Run Id", runId)}
${textField("stepId", "Step Id", stepId)}
${textField("fieldPath", "Field path (e.g. outputs.total)")}
${textField("observed", "Observed (JSON)")}
${textField("corrected", "Corrected (JSON)")}
${textField("reason", "Reason")}
${textField("reviewer", "Reviewer")}`,
    "Record correction",
  );
  return page("Record Correction", body);
}
