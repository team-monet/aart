// WaitCondition — spec §13.3. Source-of-truth 7-member discriminated union;
// the engine's wait/resume machine (architecture §4.4) switches on `type`
// and MUST be written so TypeScript's exhaustiveness check (`never` in the
// default case) fails to compile if a member is unhandled — this is why
// this module implements it as a true z.discriminatedUnion, not a loose
// object (architecture §2.2).
import { z } from "zod";

// Engine-code schema-version tag (architecture §4.7) — distinct from
// `schema-version.json`'s whole-store migration watermark (§5.5), which
// tracks the *store's* schema, not an individual record's shape. Every
// persisted WaitCondition/RunRecord carries this so a resuming engine can
// detect it doesn't recognize a stale record shape (e.g. across a
// month-scale wait spanning an engine upgrade) and fail loudly instead of
// silently misinterpreting it. Neither doc names an exact field name for
// this tag; `schemaVersion` was chosen deliberately distinct from
// schema-version.json's `version` key to avoid the two being confused. See
// AMENDMENTS.md.
const schemaVersionField = { schemaVersion: z.number().int() };

export const WaitConditionApprovalSchema = z.object({
  type: z.literal("approval"),
  taskId: z.string(),
  timeout: z.string().optional(),
  ...schemaVersionField,
});
export const WaitConditionSignalSchema = z.object({
  type: z.literal("signal"),
  name: z.string(),
  correlationId: z.string(),
  timeout: z.string().optional(),
  ...schemaVersionField,
});
export const WaitConditionTimerSchema = z.object({
  type: z.literal("timer"),
  resumeAt: z.string(),
  ...schemaVersionField,
});
export const WaitConditionWebhookSchema = z.object({
  type: z.literal("webhook"),
  event: z.string(),
  correlationId: z.string(),
  timeout: z.string().optional(),
  ...schemaVersionField,
});
export const WaitConditionExternalJobSchema = z.object({
  type: z.literal("external_job"),
  provider: z.string(),
  jobId: z.string(),
  timeout: z.string().optional(),
  ...schemaVersionField,
});
export const WaitConditionQueueSchema = z.object({
  type: z.literal("queue"),
  queue: z.string(),
  correlationId: z.string(),
  timeout: z.string().optional(),
  ...schemaVersionField,
});
export const WaitConditionManualSchema = z.object({
  type: z.literal("manual"),
  timeout: z.string().optional(),
  ...schemaVersionField,
});

export const WAIT_CONDITION_TYPES = [
  "approval",
  "signal",
  "timer",
  "webhook",
  "external_job",
  "queue",
  "manual",
] as const;
export type WaitConditionType = (typeof WAIT_CONDITION_TYPES)[number];

export const WaitConditionSchema = z.discriminatedUnion("type", [
  WaitConditionApprovalSchema,
  WaitConditionSignalSchema,
  WaitConditionTimerSchema,
  WaitConditionWebhookSchema,
  WaitConditionExternalJobSchema,
  WaitConditionQueueSchema,
  WaitConditionManualSchema,
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;
