// Expression-context assembly + typed resolution helpers built on top of
// @aart/expr's resolveExpression (architecture §3.2/§3.3). This module is
// the one place `RunRecord` -> `ExprContext` translation happens, so every
// step-executor call site resolves `{{ }}` values identically.
import { type ExprContext, type ResolveOptions, resolveExpression } from "@aart/expr";
import type { RunRecord } from "@aart/types";

/**
 * Builds the `{{ }}` resolution context for a run at its CURRENT state
 * (architecture §3.2's root table): `inputs.*` (the validated input record,
 * immutable for the run), `steps.<id>.outputs.<field>` (every completed
 * step's output, keyed by `StepTrace.stepId` — including forEach's
 * aggregate parent entries, see `step-executor.ts`), `trigger.*` (the
 * `Trigger` that started/resumed this run), `run.*` (id/workflowId/version,
 * available from run start). `secrets.*` is deliberately absent from this
 * plain object — @aart/expr treats it as an opaque root resolved via the
 * injected `secretResolver` (architecture §3.2), never read out of a
 * context object.
 */
export function buildExprContext(run: RunRecord): ExprContext {
  const steps: Record<string, { outputs: Record<string, unknown> | undefined; status: string }> = {};
  for (const trace of run.trace) {
    steps[trace.stepId] = { outputs: trace.outputs, status: trace.status };
  }
  return {
    inputs: run.inputs,
    steps,
    trigger: run.trigger,
    run: { id: run.runId, workflowId: run.workflowId, version: run.workflowVersion },
  };
}

/** Resolves every value in a `with:` record (architecture §4.2 pipeline step 1: "resolve step.with (via @aart/expr, secrets injected)"). Non-`{{ }}` values pass through `resolveExpression` unchanged, per its own documented behavior. */
export async function resolveWithRecord(
  withRecord: Record<string, unknown> | undefined,
  context: ExprContext,
  options: ResolveOptions,
): Promise<Record<string, unknown>> {
  if (!withRecord) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withRecord)) {
    resolved[key] = await resolveExpression(value, context, options);
  }
  return resolved;
}

/**
 * Resolves a `{{ }}` boolean expression (`step.if`, `step.until`). `[DECISION]`
 * truthy-coerced (standard JS truthiness) rather than a strict
 * boolean-or-throw check — neither spec nor architecture states a strictness
 * requirement here, and validation-time schema checking (spec §18.1, S4's
 * scope, not this package's) is the intended place to catch an author
 * pointing `if:`/`until:` at a non-boolean field; this runtime helper stays
 * permissive rather than duplicating that check.
 */
export async function resolveBooleanExpression(expr: string, context: ExprContext, options: ResolveOptions): Promise<boolean> {
  const resolved = await resolveExpression(expr, context, options);
  return Boolean(resolved);
}

/** Resolves a `{{ }}` expression expected to be an array (`step.forEach`). Throws a plain `Error` if the resolved value isn't an array — same "this is a validation-time concern that leaked through" framing as `duration.ts`. */
export async function resolveArrayExpression(expr: string, context: ExprContext, options: ResolveOptions): Promise<unknown[]> {
  const resolved = await resolveExpression(expr, context, options);
  if (!Array.isArray(resolved)) {
    throw new Error(`forEach expression "${expr}" resolved to a non-array value (${JSON.stringify(resolved)}) — forEach requires an array-yielding expression (spec §14.1/architecture §4.2).`);
  }
  return resolved;
}

/** Resolves a `{{ }}` (or plain-string, or absent) expression expected to yield a string — `step.idempotencyKey`, `concurrency.key`. Returns `undefined` for `undefined` input; otherwise coerces via `String()` for a non-string resolved value (e.g. a numeric `caseId`) rather than throwing, since a concurrency/idempotency key just needs to be a stable, comparable string. */
export async function resolveStringExpression(expr: string | undefined, context: ExprContext, options: ResolveOptions): Promise<string | undefined> {
  if (expr === undefined) return undefined;
  const resolved = await resolveExpression(expr, context, options);
  return typeof resolved === "string" ? resolved : String(resolved);
}
