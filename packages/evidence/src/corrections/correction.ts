// correction.ts — correction capture (spec §23.3, architecture §9.4).
import type { AartStore } from "@aart/store";
import { CorrectionSchema, type Correction } from "@aart/types";

export interface RecordCorrectionInput {
  runId: string;
  stepId: string;
  fieldPath: string;
  observed: unknown;
  corrected: unknown;
  reason: string;
  /**
   * Required, non-optional (spec §23.3 / architecture §9.4 micro-decision:
   * "the human is the author of record... reviewer is required on every
   * correction, transcribed or not"). Enforced twice: at the TS-type level
   * here (this field is not `?`) AND at the Zod level by CorrectionSchema
   * itself (`reviewer: z.string()`, not `.optional()`, S0-frozen) — a
   * Correction literally cannot be constructed, in TS or by a caller that
   * bypasses TS (raw JS, `as any`, deserialized JSON), without a human name
   * attached.
   */
  reviewer: string;
}

/**
 * The stable identity of a Correction. Spec §23.3's primitive has no `id`
 * field of its own (architecture §5.3's `corrections` table primary-keys on
 * `(run_id, step_id, field_path)` instead). This composite-key encoding is
 * what `EvalExample.createdFromCorrection` (architecture §9.7) stores to
 * reference a correction without a synthetic id the type doesn't have.
 */
export function correctionKey(correction: Pick<Correction, "runId" | "stepId" | "fieldPath">): string {
  return `${correction.runId}:${correction.stepId}:${correction.fieldPath}`;
}

/**
 * Correction capture. What `aart_record_correction` (MCP, spec §34) /
 * `aart correction add` (CLI, spec §33.3) call into — @aart/evidence owns
 * capture + outcomes logic; the review UI itself is @aart/dashboard's scope
 * (architecture §9.4/S8).
 */
export async function recordCorrection(store: AartStore, input: RecordCorrectionInput): Promise<Correction> {
  const correction: Correction = {
    runId: input.runId,
    stepId: input.stepId,
    fieldPath: input.fieldPath,
    observed: input.observed,
    corrected: input.corrected,
    reason: input.reason,
    reviewer: input.reviewer,
    createdAt: new Date().toISOString(),
  };
  // Belt-and-suspenders re-validation: RecordCorrectionInput.reviewer is
  // already non-optional at the TS level, but this catches a caller that
  // bypasses TS entirely.
  const parsed = CorrectionSchema.parse(correction);
  await store.corrections.put(parsed);
  return parsed;
}
