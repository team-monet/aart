// ModelFacingReport — spec §32.7. Two audiences for a report: a human
// (dashboard/PR comment — spec §19.3/§19.4) and a model consuming the
// result to decide its next action. This is the model-facing one: compact
// stable-key JSON, token-budgeted, headline-and-failures-first, artifact
// *references* (a uri to fetch on demand) rather than payloads inline.
import { z } from "zod";

export const ModelFacingReportSchema = z.object({
  headline: z.enum(["passed", "failed", "waiting"]),
  workflowId: z.string(),
  workflowVersion: z.string(),
  failures: z.array(
    z.object({
      stepId: z.string(),
      block: z.string(),
      error: z.string(),
    }),
  ),
  // The workflow's declared outputMapping resolved into its public result.
  // This is intentionally the compact workflow-level contract, not the
  // potentially much larger per-step trace.
  outputs: z.record(z.string(), z.unknown()),
  artifactRefs: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      uri: z.string(),
    }),
  ),
  next: z.string(),
});
export type ModelFacingReport = z.infer<typeof ModelFacingReportSchema>;
