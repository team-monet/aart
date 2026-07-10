// dry-run.ts — dry-run mode + connector fakes (architecture §9.5): "This is
// explicitly called out as required, not optional... evals must be able to
// run against workflows with external effects, without actually causing
// those effects."
//
// @aart/evidence does not depend on @aart/engine (not in this package's
// consumed-interfaces list — see this task's final report) — the ENGINE's
// own dry-run check lives at architecture §4.2/§9.5 point 1, keyed off
// `RunRecord.params.dryRun`, and is @aart/engine's (S1's) responsibility to
// enforce for REAL deployed-workflow execution. This module is
// @aart/evidence's OWN, self-contained implementation of the SAME
// dryRun + connector-fake CONVENTION (architecture §9.5 point 2: "every
// pack that declares an effectful capability MUST ship a fake alongside its
// real implementation, registered under the same block name"), scoped to
// running an eval suite's fixture "workflow" (a caller-supplied ordered
// list of steps) end-to-end with no @aart/engine/@aart/blocks-core
// dependency. The two run in genuinely different processes (engine
// executes real deployed workflows; this runs eval-suite fixtures), but
// as of S9 integration (reconciliation ledger item 7) they converge on the
// SAME vocabulary via SHARED CODE, not just documented contract:
// `DEFAULT_EFFECTFUL_CAPABILITIES`/`isEffectfulCapability` now live in
// `@aart/types` (dry-run.ts) — re-exported here for zero call-site churn
// in this package's own consumers/tests. Root SEAMS.md's E6 entry flagged
// this exact divergence risk in advance ("worth reconciling explicitly
// during S9's integration pass") — this closes it.
export { DEFAULT_EFFECTFUL_CAPABILITIES, isEffectfulCapability } from "@aart/types";
import { DEFAULT_EFFECTFUL_CAPABILITIES, isEffectfulCapability } from "@aart/types";

export interface ConnectorFakeEntry<TInput = unknown, TOutput = unknown> {
  blockId: string;
  capability: string;
  real?: (input: TInput) => TOutput | Promise<TOutput>;
  /** Required whenever `capability` is effectful — enforced by `ConnectorFakeRegistry.register()` below. */
  fake?: (input: TInput) => TOutput | Promise<TOutput>;
}

/**
 * Pack-level fake implementations, registered under the same block name as
 * the real implementation (architecture §9.5 point 2). `register()`
 * structurally enforces the "every effectful-capability block MUST ship a
 * fake" requirement — this is not just documentation, an attempt to
 * register an effectful block with no fake throws immediately.
 */
export class ConnectorFakeRegistry {
  private readonly entries = new Map<string, ConnectorFakeEntry>();

  /**
   * Generic over the block's own input/output shape (defaulting to
   * `unknown`) so callers can register a real/fake pair with a concretely
   * typed handler (e.g. `(input: { to: string }) => ...`) instead of
   * having to accept `unknown` and cast inside every handler body —
   * `runStepsWithDryRun` itself only ever needs the type-erased
   * `ConnectorFakeEntry` view (it resolves `with` to `unknown` and passes
   * it straight through), so the specific `TInput`/`TOutput` is safe to
   * erase once stored.
   */
  register<TInput = unknown, TOutput = unknown>(
    entry: ConnectorFakeEntry<TInput, TOutput>,
    effectfulCapabilities: readonly string[] = DEFAULT_EFFECTFUL_CAPABILITIES,
  ): void {
    if (isEffectfulCapability(entry.capability, effectfulCapabilities) && !entry.fake) {
      throw new Error(
        `ConnectorFakeRegistry: block "${entry.blockId}" declares effectful capability "${entry.capability}" but registered no fake — architecture §9.5 requires every effectful-capability block to ship a fake alongside its real implementation.`,
      );
    }
    this.entries.set(entry.blockId, entry as unknown as ConnectorFakeEntry);
  }

  get(blockId: string): ConnectorFakeEntry | undefined {
    return this.entries.get(blockId);
  }

  has(blockId: string): boolean {
    return this.entries.has(blockId);
  }
}

export interface EvalStepDefinition {
  id: string;
  block: string;
  /** Either a plain resolved-inputs object, or a function of prior steps' outputs — a deliberately minimal stand-in for `@aart/expr`'s `{{ steps.<id>.outputs.* }}` resolution (`@aart/expr` is not a consumed interface of this package). */
  with?: Record<string, unknown> | ((priorOutputs: Readonly<Record<string, unknown>>) => Record<string, unknown>);
}

export interface StepExecutionRecord {
  stepId: string;
  block: string;
  usedFake: boolean;
  output: unknown;
}

export interface RunStepsWithDryRunOptions {
  dryRun: boolean;
  fakes: ConnectorFakeRegistry;
  effectfulCapabilities?: readonly string[];
}

export interface RunStepsWithDryRunResult {
  /** `steps.<id>.outputs`-style lookup of each step's output, by step id. */
  outputs: Record<string, unknown>;
  trace: StepExecutionRecord[];
}

/**
 * Runs `steps` sequentially against `options.fakes`. For each step: resolve
 * `with` against prior outputs, then choose the FAKE handler iff
 * `options.dryRun` is true AND the block's registered capability is
 * effectful (`isEffectfulCapability`) — otherwise the REAL handler. This is
 * the mechanism the required test (run-suite.test.ts) exercises end-to-end:
 * an email.send-shaped effectful step run in dry-run never invokes `.real`,
 * only `.fake`, while a downstream step still receives the fake's synthetic
 * output.
 */
export async function runStepsWithDryRun(steps: EvalStepDefinition[], options: RunStepsWithDryRunOptions): Promise<RunStepsWithDryRunResult> {
  const outputs: Record<string, unknown> = {};
  const trace: StepExecutionRecord[] = [];

  for (const step of steps) {
    const entry = options.fakes.get(step.block);
    if (!entry) {
      throw new Error(`runStepsWithDryRun: no ConnectorFakeRegistry entry for block "${step.block}" (step "${step.id}")`);
    }
    const resolvedInput = typeof step.with === "function" ? step.with(outputs) : (step.with ?? {});
    const effectful = isEffectfulCapability(entry.capability, options.effectfulCapabilities);
    const useFake = options.dryRun && effectful;
    const handler = useFake ? entry.fake : entry.real;
    if (!handler) {
      throw new Error(`runStepsWithDryRun: block "${step.block}" has no ${useFake ? "fake" : "real"} handler registered for step "${step.id}"`);
    }
    const output = await handler(resolvedInput);
    outputs[step.id] = output;
    trace.push({ stepId: step.id, block: step.block, usedFake: useFake, output });
  }

  return { outputs, trace };
}
