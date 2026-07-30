// findCorrectionByKey — looks a Correction back up from the
// `correctionKey`-encoded route param the dashboard's correction-outcome
// actions (update-run-output / create-eval-example / create-issue) address
// it by. Mirrors `@aart/evidence`'s `correctionKey` encoding exactly
// (`${runId}:${stepId}:${fieldPath}`, no `id` field — spec §23.3's
// `Correction` has none; architecture §5.3's `corrections` table
// primary-keys on `(run_id, step_id, field_path)` instead) via
// `store.corrections.list({runId, stepId})` (the only query CorrectionStore
// supports) + an exact fieldPath match.
import type { AartStore } from "@aart/store";
import type { Correction } from "@aart/types";

/**
 * `key` arrives already `decodeURIComponent`-ed once by the router's own
 * `:param` matching (`http/router.ts`) — this does NOT decode again.
 * Splits on the first two colons only, so a fieldPath that itself contains
 * a colon still round-trips correctly.
 */
export async function findCorrectionByKey(store: AartStore, key: string): Promise<Correction | undefined> {
  const [runId, stepId, ...fieldPathParts] = key.split(":");
  const fieldPath = fieldPathParts.join(":");
  if (!runId || !stepId || !fieldPath) return undefined;
  const candidates = await store.corrections.list({ runId, stepId });
  return (
    candidates.find((c) => c.fieldPath === fieldPath) ??
    (await store.corrections.findByOperationalTarget(
      runId,
      stepId,
      fieldPath,
    ))
  );
}
