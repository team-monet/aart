// ScorerRegistryPort — the exact shape S6's landed `@aart/evidence` exposes
// (root SEAMS.md, "E2 — Scorer registry — consumed by @aart/blocks-core's
// eval.run/eval.score blocks (S3)", dated 2026-07-10, read from
// /Users/johnlee/code/aart-s6/SEAMS.md):
//
//   packages/evidence/src/evals/scorers/registry.ts
//   export function createScorerRegistry(options?: { llmJudge?: LlmJudgeFn }): ScorerRegistry;
//   interface ScorerRegistry {
//     readonly kinds: readonly string[];             // the 12 BUILTIN_SCORER_KINDS from @aart/types
//     get(kind: string): ScorerRegistryEntry | undefined;
//     score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
//   }
//
// `@aart/evidence` is a STUB in this worktree (S6 landed it on a sibling
// branch, `s6-evidence`, not yet merged here) — this module is the "thin
// injected boundary" the task brief calls for: `eval.run`/`eval.score`
// (eval/run.ts, eval/score.ts) are built against this port type, accepting
// an implementation via dependency injection (`createEvalBlocks`,
// eval/index.ts) rather than importing `@aart/evidence` directly. Once S9
// merges the real package, the composition root passes the REAL
// `createScorerRegistry(...)` return value in here — same shape, no block
// rewrite needed. This package's own tests inject a small scripted fake
// (test-support/fake-scorer-registry.ts), the same "fake ships alongside
// real under the same shape" discipline `@aart/evidence`'s own
// `createFakeLlmJudge` uses for ITS tests (SEAMS.md E1).
//
// Deliberately NOT re-implementing the 12 scorer kinds' actual logic here
// as a "fallback" default (contrast with report/report-renderers-port.ts,
// which DOES ship a real fallback renderer) — scorer correctness
// (exact_match/jsonpath_exact/numeric_tolerance/etc.) is genuinely
// S6-owned business logic; a blocks-core-local reimplementation would risk
// silently drifting from S6's real one. A missing injection is therefore a
// loud, explicit "not wired yet" error (see eval/index.ts), not a
// plausible-looking wrong answer.

/** Mirrors S6's `ScorerResult` shape closely enough for `eval.score`'s output — kept structurally loose (not imported from `@aart/evidence`, which has no real exports in this worktree) rather than a byte-for-byte type import. */
export interface ScorerResult {
  passed: boolean;
  score: number;
  detail?: string;
}

export interface ScorerRegistryEntry {
  readonly kind: string;
}

export interface ScorerRegistryPort {
  readonly kinds: readonly string[];
  get(kind: string): ScorerRegistryEntry | undefined;
  score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
}

/** Thrown by `eval.run`/`eval.score` when no `ScorerRegistryPort` was injected (via `createEvalBlocks`/`createBlockCatalog({ scorerRegistry })`) AND the lazy `@aart/evidence` fallback import doesn't yet export a real `createScorerRegistry` — i.e. exactly the current state of this worktree, where `@aart/evidence` is S0's empty stub. Distinct from a scoring FAILURE (a real `ScorerResult` with `passed: false`) — this is "the dependency isn't wired in," not "the assertion didn't hold." */
export class ScorerRegistryUnavailableError extends Error {
  constructor(blockId: string) {
    super(
      `${blockId}: no ScorerRegistryPort was injected and @aart/evidence's createScorerRegistry is not yet available in this build. ` +
        `Inject one explicitly via createBlockCatalog({ scorerRegistry }) (e.g. the real @aart/evidence export once merged, or a fake in tests).`,
    );
    this.name = "ScorerRegistryUnavailableError";
  }
}

/** Lazy resolution: dynamic-imports `@aart/evidence` and calls its `createScorerRegistry()` if that export exists. Returns `undefined` (never throws) when it doesn't — callers turn that into `ScorerRegistryUnavailableError` with their own block id for a clearer message. Using `unknown`-typed dynamic import deliberately: `@aart/evidence`'s stub `export {}` today means there is no real type to import against yet. */
export async function tryLoadEvidenceScorerRegistry(): Promise<ScorerRegistryPort | undefined> {
  try {
    const evidenceModule: unknown = await import("@aart/evidence");
    const candidate = (evidenceModule as Record<string, unknown>)["createScorerRegistry"];
    if (typeof candidate !== "function") return undefined;
    return (candidate as () => ScorerRegistryPort)();
  } catch {
    return undefined;
  }
}
