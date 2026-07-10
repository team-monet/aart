// model-facing.ts — spec §32.7's model-facing output contract. A DISTINCT,
// smaller structure from the human report model (architecture §9.3): "not
// a subset produced by trimming the human report, but its own renderer
// reading RunRecord directly, because its ordering/field constraints
// (headline+failures first, artifact refs not payloads, token-budgeted)
// are a different optimization target (a model's context window)."
import type { ModelFacingReport, RunRecord } from "@aart/types";
import { applyRedaction, type RedactFn } from "../redact.js";

const HEADLINE_MAP: Record<RunRecord["status"], ModelFacingReport["headline"]> = {
  completed: "passed",
  failed: "failed",
  cancelled: "failed",
  pending: "waiting",
  running: "waiting",
  waiting: "waiting",
};

/** Model-native design law (spec §32.2c): "Every tool result ends by naming the next step of the authoring loop." Deterministic, stable strings — not model-generated — so `next` participates in the stable-keys/stable-shape guarantee same as every other field. */
function nextAffordance(status: RunRecord["status"]): string {
  switch (status) {
    case "completed":
      return "Run completed successfully. No action required.";
    case "failed":
      return "Review the failures above. Record a correction via aart_record_correction, or fix the workflow and re-run.";
    case "cancelled":
      return "Run was cancelled before completion. Re-run if the work still needs to happen.";
    case "waiting":
      return "Run is waiting on an external event, approval, or timer. Check back later, or resolve the pending wait.";
    case "pending":
    case "running":
      return "Run is still in progress. Check back for a terminal status.";
    default: {
      const exhaustive: never = status;
      throw new Error(`nextAffordance: unhandled RunRecord.status "${String(exhaustive)}"`);
    }
  }
}

/**
 * Renders `run` into the spec §32.7 ModelFacingReport shape. Always calls
 * `redact` first (architecture §9.2) — see redact.ts for why
 * `resolvedSecretRefs` defaults to an empty set.
 */
export function renderModelFacing(run: RunRecord, redact: RedactFn, resolvedSecretRefs: ReadonlySet<string> = new Set()): ModelFacingReport {
  const clean = applyRedaction(run, redact, resolvedSecretRefs);

  const failures = clean.trace
    .filter((t) => t.status === "failed")
    .map((t) => ({ stepId: t.stepId, block: t.block, error: t.error ?? "Step failed with no recorded error message." }));

  // Artifact references, not payloads (spec §32.7): `uri` is Artifact.path
  // (a pointer into the artifact BLOB store, architecture §5.4) — never
  // Artifact.bytes (which is a byte COUNT, not content, but is excluded
  // here regardless to keep this contract explicit).
  const artifactRefs = clean.artifacts.map((a) => ({ id: a.id, kind: a.kind, uri: a.path }));

  return {
    headline: HEADLINE_MAP[clean.status],
    workflowId: clean.workflowId,
    workflowVersion: clean.workflowVersion,
    failures,
    artifactRefs,
    next: nextAffordance(clean.status),
  };
}
