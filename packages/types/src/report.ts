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
  // Oversized results use compactModelFacingOutputs' bounded summary and
  // RunRecord pointer instead of consuming the model's context window.
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

const MAX_INLINE_OUTPUT_CHARS = 4_096;
const MODEL_OUTPUT_PREVIEW_CHARS = 512;

function prettyPrintedJsonLength(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return JSON.stringify(value).length;

  const entries = Array.isArray(value)
    ? value.map((entry) => ({ keyChars: 0, value: entry }))
    : Object.entries(value).map(([key, entry]) => ({
        keyChars: JSON.stringify(key).length + 2,
        value: entry,
      }));
  if (entries.length === 0) return 2;

  let length = 2; // opening delimiter + first newline
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    length += (depth + 1) * 2 + entry.keyChars + prettyPrintedJsonLength(entry.value, depth + 1);
    length += index < entries.length - 1 ? 2 : 1; // comma (except last) + newline
    if (length > MAX_INLINE_OUTPUT_CHARS) return length;
  }
  return length + depth * 2 + 1; // closing indentation + delimiter
}

/**
 * Keeps bounded report surfaces (model-facing JSON and PR-comment
 * pretty-printed JSON) small while preserving full-fidelity RunRecord.outputs
 * in storage and unrestricted human reports. Small public results retain
 * their authored shape; oversized results become a compact pointer-shaped
 * summary that tells the consumer exactly where the full value lives.
 */
export function compactModelFacingOutputs(runId: string, outputs: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(outputs);
  if (
    serialized.length <= MAX_INLINE_OUTPUT_CHARS &&
    prettyPrintedJsonLength(JSON.parse(serialized)) <= MAX_INLINE_OUTPUT_CHARS
  ) {
    return outputs;
  }
  return {
    $aart: {
      kind: "truncated-workflow-outputs",
      originalChars: serialized.length,
      preview: serialized.slice(0, MODEL_OUTPUT_PREVIEW_CHARS),
      fullResultRef: { runId, field: "outputs" },
    },
  };
}
