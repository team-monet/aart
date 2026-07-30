// correction.ts — correction capture (spec §23.3, architecture §9.4).
import type { AartStore } from "@aart/store";
import {
  CorrectionSchema,
  type Correction,
  type RunRecord,
} from "@aart/types";

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

export class CorrectionInputError extends Error {
  readonly code = "INVALID_CORRECTION_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "CorrectionInputError";
  }
}

/** A public correction field matched a value already sealed for the run. */
export class CorrectionContainsKnownSecretError extends CorrectionInputError {
  constructor(runId: string) {
    super(
      `recordCorrection: correction for run "${runId}" contains a secret already known to that run and cannot be published`,
    );
    this.name = "CorrectionContainsKnownSecretError";
  }
}

const UNSAFE_CORRECTION_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isWritableCorrectionOutputPath(
  path: string,
): boolean {
  if (path === "outputs") return true;
  if (!path.startsWith("outputs.")) return false;
  const segments = path.split(".").slice(1);
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !UNSAFE_CORRECTION_PATH_SEGMENTS.has(segment),
    )
  );
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

/** Recursive value/key check matching the engine's canonical scalar policy. */
export function containsKnownSecret(
  value: unknown,
  resolvedSecretValues: readonly string[],
): boolean {
  const secrets = resolvedSecretValues.filter(
    (secret) => secret.length > 0,
  );
  if (secrets.length === 0) return false;
  if (typeof value === "string") {
    return secrets.some((secret) => value.includes(secret));
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return secrets.includes(String(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsKnownSecret(item, secrets),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        containsKnownSecret(key, secrets) ||
        containsKnownSecret(child, secrets),
    );
  }
  return false;
}

async function correctionRunContext(
  store: AartStore,
  runId: string,
): Promise<{
  run: RunRecord;
  resolvedSecretValues: readonly string[];
}> {
  const publicRun = await store.runs.get(runId);
  if (publicRun === undefined) {
    throw new CorrectionInputError(
      `recordCorrection: no such run "${runId}"`,
    );
  }
  if (publicRun.status === "waiting") {
    const waits = await store.waits.list({ runId });
    const resolved = new Set<string>();
    let exactRun = publicRun;
    for (const wait of waits) {
      const state =
        await store.waits.getOperationalRunState(
          wait.runId,
          wait.stepId,
        );
      if (state !== undefined) {
        if (state.run.trace.length >= exactRun.trace.length) {
          exactRun = state.run;
        }
        for (const value of state.resolvedSecretValues) {
          resolved.add(value);
        }
      }
    }
    return {
      run: exactRun,
      resolvedSecretValues: [...resolved],
    };
  }
  const protectedState =
    await store.runs.getOperationalState(runId);
  return {
    run: protectedState?.run ?? publicRun,
    resolvedSecretValues:
      protectedState?.resolvedSecretValues ?? [],
  };
}

/**
 * Correction capture. What `aart_record_correction` (MCP, spec §34) /
 * `aart correction add` (CLI, spec §33.3) call into — @aart/evidence owns
 * capture + outcomes logic; the review UI itself is @aart/dashboard's scope
 * (architecture §9.4/S8).
 */
export async function recordCorrection(
  store: AartStore,
  input: RecordCorrectionInput,
  now: () => Date = () => new Date(),
): Promise<Correction> {
  const correction: Correction = {
    runId: input.runId,
    stepId: input.stepId,
    fieldPath: input.fieldPath,
    observed: input.observed,
    corrected: input.corrected,
    reason: input.reason,
    reviewer: input.reviewer,
    createdAt: now().toISOString(),
  };
  // Belt-and-suspenders re-validation: RecordCorrectionInput.reviewer is
  // already non-optional at the TS level, but this catches a caller that
  // bypasses TS entirely.
  const parsed = CorrectionSchema.parse(correction);
  return store.transact(async (tx) => {
    const context = await correctionRunContext(
      tx,
      parsed.runId,
    );
    const publicFields = {
      stepId: parsed.stepId,
      fieldPath: parsed.fieldPath,
      observed: parsed.observed,
      corrected: parsed.corrected,
      reason: parsed.reason,
      reviewer: parsed.reviewer,
    };
    if (
      containsKnownSecret(
        publicFields,
        context.resolvedSecretValues,
      )
    ) {
      throw new CorrectionContainsKnownSecretError(
        parsed.runId,
      );
    }
    if (
      !context.run.trace.some(
        (trace) => trace.stepId === parsed.stepId,
      )
    ) {
      throw new CorrectionInputError(
        `recordCorrection: target step does not exist in run "${parsed.runId}"`,
      );
    }
    if (!isWritableCorrectionOutputPath(parsed.fieldPath)) {
      throw new CorrectionInputError(
        "recordCorrection: target is not a writable step output path",
      );
    }
    await tx.corrections.put(parsed, {
      stepId: parsed.stepId,
      fieldPath: parsed.fieldPath,
    });
    return parsed;
  });
}
