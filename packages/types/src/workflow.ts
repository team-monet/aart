// Workflow, WorkflowStep, Field, Example — spec §14.1.
import { z } from "zod";
import { ApprovalStateSchema, ConcurrencyPolicySchema, GatesSchema, RetryPolicySchema } from "./governance.js";

/** Closed vocabulary understood by workflow input/output contract validation. */
export const SUPPORTED_FIELD_TYPES = ["any", "array", "boolean", "integer", "json", "null", "number", "object", "string", "unknown"] as const;

export const FieldSchema = z.object({
  name: z.string(),
  type: z.enum(SUPPORTED_FIELD_TYPES),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
  pattern: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const ExampleSchema = z.object({
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});
export type Example = z.infer<typeof ExampleSchema>;

export const WorkflowStepSchema = z.object({
  id: z.string(),
  uses: z.string(),
  with: z.record(z.string(), z.unknown()).optional(),
  if: z.string().optional(),
  then: z.string().optional(),
  else: z.string().optional(),
  next: z.string().optional(),
  forEach: z.string().optional(),
  as: z.string().optional(),
  maxIterations: z.number().optional(),
  until: z.string().optional(),
  retry: RetryPolicySchema.optional(),
  timeout: z.string().optional(),
  idempotencyKey: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  inputs: z.array(FieldSchema),
  outputs: z.array(FieldSchema),
  execution: z.object({
    type: z.literal("workflow"),
    steps: z.array(WorkflowStepSchema),
    outputMapping: z.record(z.string(), z.string()).optional(),
  }),
  approval: ApprovalStateSchema,
  gates: GatesSchema,
  category: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  examples: z.array(ExampleSchema).optional(),
  generatedByModel: z.string().optional(),
  // Architecture-introduced, beyond spec §14.1's literal Workflow shape
  // (architecture §5.3's `workflows` table: `needs_review`, `promotion_blocked`
  // columns; A21/A30 fixes; spec §23.4 correction-outcome list). Added here,
  // on the canonical type, following the same flag-and-add pattern this
  // architecture already uses for RunRecord.flag (run.ts) and
  // Trigger.dedupeKey (trigger.ts), rather than inventing a parallel
  // store-only query surface for two booleans consumed at promotion-check
  // time. See AMENDMENTS.md.
  needsReview: z.boolean().optional(),
  promotionBlocked: z.boolean().optional(),
  // Architecture-introduced (S1/Wave-1 amendment — see AMENDMENTS.md A16),
  // same flag-and-add pattern as needsReview/promotionBlocked immediately
  // above and RunRecord.flag (run.ts)/Trigger.dedupeKey (trigger.ts): spec
  // §30.1 shows `concurrency: { key, policy }` as a "per workflow" YAML
  // example, and architecture §4.3 fully designs the enforcement semantics
  // for all four ConcurrencyPolicy values against this exact shape, but
  // neither document ever adds a field for it to spec §14.1's literal
  // Workflow TS block — without a home on the canonical type, the engine's
  // trigger-intake path (architecture §4.3) has no way to read a workflow's
  // declared concurrency policy at all. `key` is a `{{ }}` expression
  // resolved against `inputs.*` at trigger time (architecture §4.3).
  concurrency: z
    .object({
      key: z.string(),
      policy: ConcurrencyPolicySchema,
    })
    .optional(),
});
export type Workflow = z.infer<typeof WorkflowSchema>;
