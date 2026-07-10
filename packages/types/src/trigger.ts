// Trigger, Signal — spec §13.1, §13.4.
import { z } from "zod";

// Fields shared by every Trigger.type member. Spec §13.1 types `Trigger` as
// one flat object whose `type` field is a 13-member string-literal union;
// every member happens to share the same remaining fields today. This module
// still implements `type` as a true Zod discriminated union (z.discriminatedUnion,
// not z.object({ type: z.enum([...]) })) per this task's explicit directive —
// downstream exhaustive switches (architecture §2.2: @aart/server's trigger
// adapter registry, §6, is keyed on this discriminant) depend on it, and a
// discriminated union additionally leaves room for a future per-type field
// to be added to one member without restructuring every other member.
const triggerCommonShape = {
  id: z.string(),
  source: z.string(),
  payload: z.unknown(),
  correlationId: z.string().optional(),
  receivedAt: z.string(),
  // FLAGGED DIVERGENCE from spec §13.1 (architecture §6.1, A8/F5 fix): spec's
  // Trigger has no delivery/dedup identifier. This optional field is additive
  // — populated from a natural delivery id where the adapter has one
  // (X-GitHub-Delivery, a queue message id, an email Message-ID); adapters
  // with no natural id (manual/cli/sdk) leave it unset. See AMENDMENTS.md.
  dedupeKey: z.string().optional(),
};

const TriggerManualSchema = z.object({ type: z.literal("manual"), ...triggerCommonShape });
const TriggerMcpSchema = z.object({ type: z.literal("mcp"), ...triggerCommonShape });
const TriggerCliSchema = z.object({ type: z.literal("cli"), ...triggerCommonShape });
const TriggerWebhookSchema = z.object({ type: z.literal("webhook"), ...triggerCommonShape });
const TriggerScheduleSchema = z.object({ type: z.literal("schedule"), ...triggerCommonShape });
const TriggerEmailSchema = z.object({ type: z.literal("email"), ...triggerCommonShape });
const TriggerFileSchema = z.object({ type: z.literal("file"), ...triggerCommonShape });
const TriggerQueueSchema = z.object({ type: z.literal("queue"), ...triggerCommonShape });
const TriggerDatabaseSchema = z.object({ type: z.literal("database"), ...triggerCommonShape });
const TriggerGithubSchema = z.object({ type: z.literal("github"), ...triggerCommonShape });
const TriggerSlackSchema = z.object({ type: z.literal("slack"), ...triggerCommonShape });
const TriggerPollSchema = z.object({ type: z.literal("poll"), ...triggerCommonShape });
const TriggerSdkSchema = z.object({ type: z.literal("sdk"), ...triggerCommonShape });

export const TRIGGER_TYPES = [
  "manual",
  "mcp",
  "cli",
  "webhook",
  "schedule",
  "email",
  "file",
  "queue",
  "database",
  "github",
  "slack",
  "poll",
  "sdk",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const TriggerSchema = z.discriminatedUnion("type", [
  TriggerManualSchema,
  TriggerMcpSchema,
  TriggerCliSchema,
  TriggerWebhookSchema,
  TriggerScheduleSchema,
  TriggerEmailSchema,
  TriggerFileSchema,
  TriggerQueueSchema,
  TriggerDatabaseSchema,
  TriggerGithubSchema,
  TriggerSlackSchema,
  TriggerPollSchema,
  TriggerSdkSchema,
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const SignalSchema = z.object({
  id: z.string(),
  name: z.string(),
  correlationId: z.string(),
  payload: z.unknown(),
  receivedAt: z.string(),
});
export type Signal = z.infer<typeof SignalSchema>;
