// The shared trigger-intake pipeline — architecture §6, this session's DoD:
// dedupeKey check, resume-vs-start correlation routing (§6.3), poison-guard
// shed, backpressure ceiling, trigger→input mapping (§6.2) via @aart/expr,
// and durable rejected-trigger persistence for every rejection path. Every
// one of the 13 adapters (adapters.ts) funnels its adapted delivery through
// `processTriggerIntake` — this is the "all adapters share one contract"
// convergence point architecture §6.1 describes.
import { resolveExpression } from "@aart/expr";
import type { AartStore } from "@aart/store";
import type { RejectedTrigger, Signal, Trigger } from "@aart/types";
import type { Clock } from "../clock.js";
import type { BackpressureConfig, PoisonGuardConfig } from "../config.js";
import type { EngineBoundary } from "../engine/boundary.js";
import { generateId } from "../ids.js";
import type { Logger } from "../logger.js";
import { correlationKeyFor, isOverBackpressureCeiling, isPoisonFlagged } from "../poison.js";
import type { AdaptedTrigger, IntakeOutcome, TriggerBinding, TriggerRejectionReason } from "./types.js";

export interface IntakeDeps {
  store: AartStore;
  engine: EngineBoundary;
  clock: Clock;
  logger: Logger;
  backpressure?: BackpressureConfig;
  poisonGuard?: PoisonGuardConfig;
}

/** Durable rejected-trigger persistence (architecture §6.2) — the one place every rejection path writes from, so a rejection is queryable after the fact (`aart_list_waiting_runs`/dashboard, per architecture §6.2's own framing) rather than only logged to stdout. Exported directly: the HTTP layer's bad-HMAC 401 path (architecture §6.1) rejects BEFORE a `Trigger` even exists to hand to `processTriggerIntake`, so it calls this helper on its own. */
export async function recordRejectedTrigger(deps: Pick<IntakeDeps, "store" | "clock" | "logger">, triggerType: string, reason: TriggerRejectionReason, rawPayload: unknown): Promise<void> {
  const rejected: RejectedTrigger = {
    id: generateId("rej"),
    triggerType,
    reason,
    rawPayload,
    receivedAt: deps.clock.nowIso(),
  };
  await deps.store.rejectedTriggers.append(rejected);
  deps.logger.warn("trigger rejected", { triggerType, reason });
}

/** Resolves spec §21.3's `triggerMapping` (`{{ }}` expressions against a `{ trigger }` context, architecture §6.2) into the run's mapped inputs. Absent `triggerMapping` passes `trigger.payload` through as-is if it's a plain object, or `{}` otherwise — a reasonable default for adapters (manual/cli/sdk) typically invoked with already-input-shaped payloads. */
export async function resolveTriggerMapping(triggerMapping: Record<string, string> | undefined, trigger: Trigger): Promise<Record<string, unknown>> {
  if (!triggerMapping) {
    return trigger.payload && typeof trigger.payload === "object" && !Array.isArray(trigger.payload) ? (trigger.payload as Record<string, unknown>) : {};
  }
  const context = { trigger: trigger as unknown };
  const result: Record<string, unknown> = {};
  for (const [inputName, expr] of Object.entries(triggerMapping)) {
    result[inputName] = await resolveExpression(expr, context);
  }
  return result;
}

/**
 * `Trigger.dedupeKey` check (architecture §6.1's FLAGGED DIVERGENCE):
 * "Intake checks dedupeKey (when present) against previously-seen keys for
 * that trigger/deployment before run creation." No dedicated store member
 * exists for a delivery-identity ledger independent of the runs it produced
 * (the frozen `AartStore` interface's 16 members + job_queue/idempotency_
 * ledger have no such member, and adding one is outside this session's
 * carve-out — `packages/store/src/types.ts` is S0-owned). This checks
 * already-created runs' own embedded `trigger.dedupeKey` for a match,
 * scoped to `workflowId` to bound the scan. Documented, flagged limitation
 * (linear in that workflow's run count, not an indexed lookup) — root
 * AMENDMENTS.md A20, S9 resolution 2026-07-10: DEFERRED, accepted for v1.
 * The proposed fix (a small dedicated `RunStore.findByDedupeKey` member,
 * adapter-implementable as an indexed lookup) is a real `AartStore`
 * interface-shape change deferred until a workflow's per-workflow run
 * count makes this scan actually matter in practice - revisit there.
 */
async function findRunByDedupeKey(store: AartStore, workflowId: string, dedupeKey: string): Promise<string | undefined> {
  const runs = await store.runs.list({ workflowId });
  return runs.find((r) => r.trigger.dedupeKey === dedupeKey)?.runId;
}

/**
 * The convergence point every trigger adapter's `AdaptedTrigger` output
 * runs through. Order matters and is deliberate:
 * 1. dedupeKey (a redelivery is a no-op regardless of anything else)
 * 2. resume routing (§6.3) — resume traffic never touches the poison/
 *    backpressure guards below, which are §4.3/§6.2 admission concerns for
 *    NEW runs specifically
 * 3. poison-flagged shed (checked before backpressure — a poison-flagged
 *    key should shed with `poison_flagged`, not `backlog_ceiling`, even if
 *    both conditions happen to be true, since poison is the more specific,
 *    more actionable diagnosis)
 * 4. backpressure ceiling
 * 5. input mapping
 * 6. engine.startRun (which itself enforces the per-workflow
 *    ConcurrencyPolicy, architecture §4.3 — not this package's job to
 *    reimplement)
 */
export async function processTriggerIntake(deps: IntakeDeps, binding: TriggerBinding, adapted: AdaptedTrigger): Promise<IntakeOutcome> {
  const { trigger } = adapted;

  if (trigger.dedupeKey) {
    const existingRunId = await findRunByDedupeKey(deps.store, binding.workflowId, trigger.dedupeKey);
    if (existingRunId) {
      await recordRejectedTrigger(deps, trigger.type, "duplicate_delivery", trigger.payload);
      return { kind: "rejected", reason: "duplicate_delivery" };
    }
  }

  if (adapted.resumeSignal) {
    const signal: Signal = {
      id: generateId("sig"),
      name: adapted.resumeSignal.name,
      correlationId: adapted.resumeSignal.correlationId,
      payload: adapted.resumeSignal.payload,
      receivedAt: deps.clock.nowIso(),
    };
    await deps.store.signals.append(signal);
    const result = await deps.engine.resumeWithSignal(signal);
    if (result.kind === "resumed") return { kind: "resumed", runId: result.runId };
    if (result.kind === "duplicate") return { kind: "duplicate_resume", runId: result.runId };
    if (result.kind === "ambiguous") {
      // architecture §4.4.2: "more than one -> this is a modeling error...
      // fail loudly, do not guess." Not one of the six canonical
      // rejected-trigger reasons (it isn't a rejected DELIVERY, it's an
      // ambiguous correlation state) — logged loudly instead, per the spec.
      deps.logger.error("ambiguous signal correlation — more than one outstanding wait matched", { signalName: signal.name, correlationId: signal.correlationId, matches: result.matches });
      return { kind: "ambiguous", matches: result.matches };
    }
    // zero match: "drop/log unmatched signal for later inspection" — the
    // signal itself is still durably appended above (SignalStore.append),
    // so it's inspectable; nothing further to do here.
    deps.logger.info("signal received with no matching outstanding wait", { signalName: signal.name, correlationId: signal.correlationId });
    return { kind: "no_match" };
  }

  const poisonFlag = await isPoisonFlagged(deps.store, binding.workflowId, trigger);
  if (poisonFlag) {
    await recordRejectedTrigger(deps, trigger.type, "poison_flagged", trigger.payload);
    return { kind: "rejected", reason: "poison_flagged" };
  }

  if (await isOverBackpressureCeiling(deps.store, deps.backpressure?.maxPendingRuns)) {
    await recordRejectedTrigger(deps, trigger.type, "backlog_ceiling", trigger.payload);
    return { kind: "rejected", reason: "backlog_ceiling" };
  }

  let mappedInputs: Record<string, unknown>;
  try {
    mappedInputs = await resolveTriggerMapping(binding.triggerMapping, trigger);
  } catch (err) {
    await recordRejectedTrigger(deps, trigger.type, "input_mapping_failed", trigger.payload);
    return { kind: "rejected", reason: "input_mapping_failed", detail: err instanceof Error ? err.message : String(err) };
  }

  const result = await deps.engine.startRun({
    workflowId: binding.workflowId,
    workflowVersion: binding.workflowVersion,
    trigger,
    mappedInputs,
    // AMENDMENTS.md (S15): threads this binding's target environment
    // (deploymentToBinding, registry.ts) into the engine boundary, which is
    // what lets the real capability-dispatch chokepoint (architecture §4.6)
    // gate this trigger-fired run by its actual deployed environment's
    // trust mode — see StartRunParams.environment's own doc comment
    // (engine/boundary.ts) for the full story on the gap this closes.
    environment: binding.environmentId,
  });
  if (result.kind === "started") return { kind: "started", runId: result.runId };
  if (result.kind === "queued") return { kind: "queued", runId: result.runId };
  await recordRejectedTrigger(deps, trigger.type, "concurrency_rejected", trigger.payload);
  return { kind: "rejected", reason: "concurrency_rejected", detail: result.reason };
}

export { correlationKeyFor };
