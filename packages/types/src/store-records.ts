// Deployment, Environment, Schedule, PromptRegistryEntry, SchemaRegistryEntry,
// PackManifest, Correction, RejectedTrigger — spec §27-29, §16 (pack
// manifest), §23.3 (correction); §6.2 RejectedTrigger is architecture-
// introduced in full (architecture §5's FLAGGED DIVERGENCE note, F5 fix).
//
// None of these eight types has an exact spec TS block the way
// trigger.ts/wait.ts/run.ts etc. do — spec describes them in prose/YAML
// examples (§27 deployment modes, §29 scheduling, §16 packs) or, for
// Correction, a JSON example (§23.3). Their field-level shape here is
// derived from architecture §5.3's SQL table columns (the one place these
// entities' full field lists are actually given), camelCased to match this
// module's convention elsewhere. See this task's final report for the
// overall resolved-ambiguity note covering this file.
import { z } from "zod";

export const DeploymentSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  environmentId: z.string(),
  triggerConfig: z.record(z.string(), z.unknown()),
  bundleHash: z.string().optional(),
  createdAt: z.string(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  secretSource: z.record(z.string(), z.unknown()).optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

// missed_run_policy — spec §29 doesn't enumerate values; architecture §6.1's
// trigger-adapter table gives the three explicit policy names.
export const MissedRunPolicySchema = z.enum(["skip", "fire_once", "fire_all"]);
export type MissedRunPolicy = z.infer<typeof MissedRunPolicySchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  cron: z.string(),
  timezone: z.string(),
  missedRunPolicy: MissedRunPolicySchema,
  inputs: z.record(z.string(), z.unknown()).optional(),
  paused: z.boolean(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const PromptRegistryEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  contentHash: z.string(),
  body: z.string(),
});
export type PromptRegistryEntry = z.infer<typeof PromptRegistryEntrySchema>;

export const SchemaRegistryEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  contentHash: z.string(),
  jsonSchema: z.record(z.string(), z.unknown()),
});
export type SchemaRegistryEntry = z.infer<typeof SchemaRegistryEntrySchema>;

export const PackManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  contentHash: z.string(),
  manifest: z.record(z.string(), z.unknown()),
  // spec §16.2's lifecycle diagram + ADR-12 ("imported packs land
  // unapproved") name at least "unapproved"/"approved" states in prose, but
  // neither doc gives an explicit closed enum. Kept as z.string() rather
  // than fabricating a possibly-incomplete 2-value enum.
  approvalStatus: z.string(),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

export const CorrectionSchema = z.object({
  runId: z.string(),
  stepId: z.string(),
  fieldPath: z.string(),
  observed: z.unknown(),
  corrected: z.unknown(),
  reason: z.string(),
  // Non-optional per spec §23.3: "the human is the author of record: the
  // `reviewer` field is required on every correction, transcribed or not"
  // (architecture micro-decision #30 — structurally impossible to omit).
  reviewer: z.string(),
  createdAt: z.string(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

// RejectedTrigger — architecture §6.2, architecture-introduced in full (no
// spec anchor at all; F5 fix). `reason`'s enum is given verbatim in
// architecture §5.3's SQL comment on `rejected_triggers.reason`, including
// "duplicate_delivery" per the A34/G10 fix.
export const RejectedTriggerReasonSchema = z.enum([
  "bad_hmac",
  "input_mapping_failed",
  "concurrency_rejected",
  "backlog_ceiling",
  "poison_flagged",
  "duplicate_delivery",
]);
export type RejectedTriggerReason = z.infer<typeof RejectedTriggerReasonSchema>;

export const RejectedTriggerSchema = z.object({
  id: z.string(),
  triggerType: z.string(),
  reason: RejectedTriggerReasonSchema,
  rawPayload: z.unknown(),
  receivedAt: z.string(),
});
export type RejectedTrigger = z.infer<typeof RejectedTriggerSchema>;
