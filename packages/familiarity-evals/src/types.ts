// types.ts — the core familiarity-eval vocabulary (spec §32.4, ADR-15).
export interface AuthoringTask {
  id: string;
  /** The natural-language prompt a target model receives, zero-shot (spec §32.4: "authoring tasks, run zero-shot against a set of target models"). */
  prompt: string;
  /** The block id(s) a CORRECT solution is expected to use — spec §32.4's "correct-block-choice" metric: "did the model pick the intended block, not a plausible-but-wrong one." */
  expectedBlocks: string[];
  /** Free-text tags — this package's own catalog (tasks/catalog.ts) links each task back to spec §32.3's recipe catalog via these. */
  tags?: string[];
}

export interface ValidateResult {
  valid: boolean;
  errors: string[];
}

/**
 * The seam this package expects the REAL `aart_validate` (spec §18's full
 * 5-class validation engine, owned by @aart/governance/S4) to satisfy.
 * @aart/governance is a concurrent Wave-1 session, not built yet — this
 * package is not allowed to depend on it (must be "fully offline-testable,"
 * this session's DoD). validate.ts ships a small reference implementation
 * for this package's own offline tests; wiring the REAL governance
 * validator in is S9's job. See SEAMS.md.
 */
export type ValidateFn = (workflow: unknown) => ValidateResult | Promise<ValidateResult>;

export interface RunSuccessResult {
  succeeded: boolean;
  error?: string;
}

/**
 * The seam this package expects a real workflow-execution path
 * (ultimately @aart/engine, S1) to satisfy for "did the model's workflow
 * actually run" scoring (spec §32.4: "run success"). Same not-built-yet
 * situation as ValidateFn — run-success.ts ships a reference
 * implementation; the real wiring is S9's job. See SEAMS.md.
 */
export type RunSuccessFn = (workflow: unknown) => RunSuccessResult | Promise<RunSuccessResult>;

export interface ModelAttemptResult {
  /** The model's raw text response to the task prompt. */
  rawOutput: string;
  /** The workflow object PARSED out of rawOutput, if parsing succeeded at all — a model that returns unparseable garbage has already failed "first-draft validity" before validation is even attempted. */
  workflow?: unknown;
}

/**
 * A target model under test (spec §32.4: "run zero-shot against a set of
 * target models, deliberately including one weak model — the sensitive
 * detector"). `priorAttempts` lets a real adapter build a corrective-round
 * prompt (this task's own output + the validation errors it produced) —
 * model SELECTION (which real models to register, including the
 * deliberately-weak one) is a caller/S9 concern, not this type's.
 */
export type ModelRunner = (
  task: AuthoringTask,
  priorAttempts: ReadonlyArray<{ output: string; errors: string[] }>,
) => Promise<ModelAttemptResult>;
