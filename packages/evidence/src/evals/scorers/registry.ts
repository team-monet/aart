// registry.ts — the scorer registry keyed by `Scorer.kind` (architecture
// §9.5). @aart/blocks-core's `eval.run`/`eval.score` blocks (spec §15.3,
// S3's scope) call into this registry — see SEAMS.md.
import { BUILTIN_SCORER_KINDS } from "@aart/types";
import { artifactExists } from "./artifact-exists.js";
import { classificationMatch } from "./classification-match.js";
import { customNode } from "./custom-node.js";
import { exactMatch } from "./exact-match.js";
import { fieldLevelAccuracy } from "./field-level-accuracy.js";
import { jsonpathContains } from "./jsonpath-contains.js";
import { jsonpathExact } from "./jsonpath-exact.js";
import { createLlmJudgeScorer, type LlmJudgeFn } from "./llm-judge.js";
import { noConsoleErrors } from "./no-console-errors.js";
import { numericTolerance } from "./numeric-tolerance.js";
import { regexScorer } from "./regex.js";
import { screenshotExists } from "./screenshot-exists.js";
import type { AsyncScorerFn, PureScorerFn, ScorerResult } from "./types.js";

export interface ScorerRegistryEntry {
  kind: string;
  deterministic: boolean;
  score: PureScorerFn | AsyncScorerFn;
}

export interface ScorerRegistry {
  readonly kinds: readonly string[];
  get(kind: string): ScorerRegistryEntry | undefined;
  score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
}

export interface CreateScorerRegistryOptions {
  /** Injected per the S6<->S7 seam (SEAMS.md) — required only if the `llm_judge` kind is actually invoked; the other 11 kinds work with no options at all. */
  llmJudge?: LlmJudgeFn;
}

function pureEntry(kind: string, fn: PureScorerFn): ScorerRegistryEntry {
  return { kind, deterministic: true, score: fn };
}

/** Builds the full 12-kind scorer registry (architecture §9.5, F6 fix: JSONPath exact and JSONPath contains are two distinct kinds). */
export function createScorerRegistry(options: CreateScorerRegistryOptions = {}): ScorerRegistry {
  const entries = new Map<string, ScorerRegistryEntry>([
    ["exact_match", pureEntry("exact_match", exactMatch)],
    ["jsonpath_exact", pureEntry("jsonpath_exact", jsonpathExact)],
    ["jsonpath_contains", pureEntry("jsonpath_contains", jsonpathContains)],
    ["regex", pureEntry("regex", regexScorer)],
    ["numeric_tolerance", pureEntry("numeric_tolerance", numericTolerance)],
    ["field_level_accuracy", pureEntry("field_level_accuracy", fieldLevelAccuracy)],
    ["classification_match", pureEntry("classification_match", classificationMatch)],
    ["artifact_exists", pureEntry("artifact_exists", artifactExists)],
    ["screenshot_exists", pureEntry("screenshot_exists", screenshotExists)],
    ["no_console_errors", pureEntry("no_console_errors", noConsoleErrors)],
    ["custom_node", pureEntry("custom_node", customNode)],
    [
      "llm_judge",
      {
        kind: "llm_judge",
        deterministic: false,
        score: options.llmJudge
          ? createLlmJudgeScorer(options.llmJudge)
          : async (): Promise<ScorerResult> => {
              throw new Error(
                "llm_judge scorer invoked with no LlmJudgeFn configured — pass { llmJudge } to createScorerRegistry(). See SEAMS.md for the @aart/llm (S7) seam this is waiting on.",
              );
            },
      },
    ],
  ]);

  return {
    kinds: BUILTIN_SCORER_KINDS,
    get: (kind) => entries.get(kind),
    async score(kind, actual, expected, config) {
      const entry = entries.get(kind);
      if (!entry) {
        throw new Error(`Unknown scorer kind "${kind}". Known kinds: ${BUILTIN_SCORER_KINDS.join(", ")}`);
      }
      return entry.score(actual, expected, config);
    },
  };
}
