// EvalSuite, EvalExample, EvalRun, Scorer, ImprovementBrief — spec §24.1-24.4, §25.2.
import { z } from "zod";

// spec §24.3 documents 12 built-in scorer kinds in prose (exact match,
// JSONPath exact, JSONPath contains, regex, numeric tolerance, field-level
// accuracy, classification match, artifact exists, screenshot exists, no
// console errors, custom node scorer, LLM judge — architecture §9.5's F6
// fix corrects the count from 11 to 12, JSONPath exact/contains being
// distinct kinds), not as a closed TS union in §24.1's Scorer block itself
// (`kind: string`). Kept open (z.string()) rather than a closed z.enum for
// the same reason as RetryPolicy.backoff (governance.ts): a custom/pack
// scorer kind shouldn't be rejected by @aart/types itself.
export const BUILTIN_SCORER_KINDS = [
  "exact_match",
  "jsonpath_exact",
  "jsonpath_contains",
  "regex",
  "numeric_tolerance",
  "field_level_accuracy",
  "classification_match",
  "artifact_exists",
  "screenshot_exists",
  "no_console_errors",
  "custom_node",
  "llm_judge",
] as const;

export const ScorerSchema = z.object({
  id: z.string(),
  kind: z.string(),
  config: z.unknown().optional(),
});
export type Scorer = z.infer<typeof ScorerSchema>;

export const EvalExampleSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  sourceRunId: z.string().optional(),
  input: z.unknown(),
  expected: z.unknown(),
  scorerConfig: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  createdFromCorrection: z.string().optional(),
});
export type EvalExample = z.infer<typeof EvalExampleSchema>;

export const EvalSuiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  examples: z.array(EvalExampleSchema),
  scorer: ScorerSchema,
  tags: z.array(z.string()),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export const EvalRunSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  status: z.enum(["completed", "failed"]),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  score: z.number(),
  regressions: z.array(z.string()),
  improvements: z.array(z.string()),
  reportArtifact: z.string(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

// ImprovementBrief — spec §25.2. A model-facing artifact (spec §32.7): a
// defined schema, not prose, for the same reliable-parseable-keys reason as
// ModelFacingReport (report.ts).
export const ImprovementBriefSchema = z.object({
  workflowId: z.string(),
  workflowVersion: z.string(),
  problemSummary: z.string(),
  failedEvalIds: z.array(z.string()),
  corrections: z.array(
    z.object({
      summary: z.string(),
      sourceRunId: z.string().optional(),
      fieldPath: z.string().optional(),
    }),
  ),
  constraints: z.array(z.string()),
});
export type ImprovementBrief = z.infer<typeof ImprovementBriefSchema>;
