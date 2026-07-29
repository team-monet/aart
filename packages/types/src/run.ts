// RunRecord (+ flag, FLAGGED DIVERGENCE), StepTrace, ExecutionSnapshot,
// ExternalCallMetadata — spec §19.1, §19.2; architecture §4.1, §4.5, §4.7.
import { z } from "zod";
import { ArtifactSchema } from "./artifact.js";
import { TrustModeSchema } from "./governance.js";
import { LlmCallMetadataSchema } from "./llm.js";
import { TriggerSchema } from "./trigger.js";
import { WaitConditionSchema } from "./wait.js";

export const ExternalCallMetadataSchema = z.object({
  system: z.string(),
  domain: z.string(),
  method: z.string().optional(),
  status: z.number().optional(),
  durationMs: z.number(),
});
export type ExternalCallMetadata = z.infer<typeof ExternalCallMetadataSchema>;

export const ExecutionSnapshotSchema = z.object({
  // The frozen, full definition tree (workflow + referenced blocks/packs)
  // exactly as it existed at trigger time. Deliberately z.unknown() here:
  // the closure this captures spans Workflow + block/pack definitions this
  // module doesn't otherwise compose into one recursive schema, and
  // architecture §4.5 itself types `definitions: unknown`.
  definitions: z.unknown(),
  resolvedVersions: z.record(z.string(), z.string()),
  packHashes: z.record(z.string(), z.string()),
  capturedAt: z.string(),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

export const StepStatusSchema = z.enum(["pending", "running", "waiting", "completed", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const StepTraceSchema = z.object({
  seq: z.number(),
  stepId: z.string(),
  block: z.string(),
  status: StepStatusSchema,
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  artifacts: z.array(ArtifactSchema).optional(),
  llmCall: LlmCallMetadataSchema.optional(),
  externalCalls: z.array(ExternalCallMetadataSchema).optional(),
  // Architecture-introduced, beyond spec §19.2's literal StepTrace shape
  // (architecture §5.3 `step_traces.post_hoc_corrected`, F5 fix; spec §23.4
  // "update current run output" correction outcome). See AMENDMENTS.md.
  postHocCorrected: z.boolean().optional(),
  // Persistence-safe taint bit: true when this step's observable behavior
  // depends on a value removed by secret redaction. The value itself is
  // never retained; the bit survives store reloads so downstream steps
  // cannot launder a redaction marker into a public workflow output.
  secretTainted: z.boolean().optional(),
  // Output-level provenance. `*` means an arbitrary transformation may
  // have used secret data; otherwise entries are JSON pointers relative
  // to `outputs` whose values were changed by redaction.
  secretTaintedPaths: z.array(z.string()).optional(),
  // This occurrence, or the edge that selected it, depended on secret
  // data. Kept separate from output-data taint so a clean final loop
  // occurrence is not poisoned by an unrelated secret field.
  controlSecretTainted: z.boolean().optional(),
  // Stable authored identity. forEach child traces use a rendered stepId
  // such as `map[0]`, but ownership never depends on parsing that string.
  authoredStepId: z.string().optional(),
  iterationIndex: z.number().int().nonnegative().optional(),
});
export type StepTrace = z.infer<typeof StepTraceSchema>;

// RunFlag — architecture §4.1 (F3 fix), FLAGGED DIVERGENCE from spec §19.1.
// RunRecord.status stays exactly the spec's 6-value enum; this is a
// separate, nullable field distinguishing a flagged `failed` run (needs
// explicit human attention before ever being auto-retried again) from an
// ordinary unflagged `failed` run. Set by §4.7's reclaim-exhaustion sweep
// and §6.2's poison-run guard (both S2); cleared by a human action
// (dashboard/CLI only, architecture §13.3/A33 — deliberately not exposed
// via MCP), which sets clearedBy/clearedAt on the *existing* flag record
// rather than deleting it, preserving the audit trail.
export const RunFlagSchema = z.object({
  kind: z.enum(["reclaim_exhausted", "poison"]),
  flaggedAt: z.string(),
  clearedBy: z.string().optional(),
  clearedAt: z.string().optional(),
});
export type RunFlag = z.infer<typeof RunFlagSchema>;

export const RunStatusSchema = z.enum(["pending", "running", "waiting", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  status: RunStatusSchema,
  // `approved` is derived, not independently set: captured once at trigger
  // time, reflecting whether the workflow was approved with all
  // approvalMode-required gates passed at that moment. It does not change
  // retroactively — ExecutionSnapshot is what keeps that captured state
  // reproducible (spec §19.1).
  approved: z.boolean(),
  approvalMode: TrustModeSchema,
  trigger: TriggerSchema,
  inputs: z.record(z.string(), z.unknown()),
  // JSON pointers within the immutable run inputs / trigger payload that
  // were changed when a later secret resolution discovered a matching
  // value. These roots can feed steps and public output mappings just like
  // StepTrace.outputs, so their provenance must survive persistence too.
  secretTaintedInputPaths: z.array(z.string()).optional(),
  secretTaintedTriggerPaths: z.array(z.string()).optional(),
  // Per-run execution options (verbosity, step timeout overrides) —
  // operational tuning, distinct from `inputs` (the workflow's declared
  // data contract); params never affect approval or gates (spec §19.1 Fix F).
  params: z.record(z.string(), z.unknown()).optional(),
  trace: z.array(StepTraceSchema),
  waits: z.array(WaitConditionSchema),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  artifacts: z.array(ArtifactSchema),
  snapshot: ExecutionSnapshotSchema,
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().optional(),
  // FLAGGED DIVERGENCE from spec §19.1 — architecture §4.1, F3 fix. See
  // module comment on RunFlagSchema above.
  flag: RunFlagSchema.nullable().optional(),
  // Engine-code schema-version tag — architecture §4.7. See wait.ts's
  // identical field for the shared rationale/naming note (AMENDMENTS.md).
  schemaVersion: z.number().int(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
