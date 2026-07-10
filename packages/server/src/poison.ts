// Backpressure (queue-backlog ceiling) and the poison-run guard —
// architecture §6.2. Two related, distinct guards layered on top of §4.3's
// admission control.
import type { AartStore } from "@aart/store";
import type { RunFlag, RunRecord, Trigger } from "@aart/types";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, DEFAULT_MAX_PENDING_RUNS, DEFAULT_POISON_WINDOW_MS } from "./config.js";

/**
 * architecture §6.2 `[DECISION]`: "workflow id + resolved concurrency key if
 * declared, else workflow id + triggering Trigger.id." This package has no
 * persisted "resolved concurrency key" independent of the engine's own
 * (internal, architecture §4.3) concurrency-policy bookkeeping — the closest
 * available proxy on the frozen `Trigger` shape is `correlationId` (present
 * exactly when a workflow declares a `concurrency.key` expression that
 * resolves through the same trigger-payload data most `correlationId`s are
 * drawn from) falling back to `Trigger.id` (the literal "else...Trigger.id"
 * case) when absent. Documented as a deliberate, interface-constrained
 * interpretation — see this task's final report.
 */
export function correlationKeyFor(workflowId: string, trigger: Pick<Trigger, "id" | "correlationId">): string {
  return `${workflowId}::${trigger.correlationId ?? trigger.id}`;
}

function keyOf(run: RunRecord): string {
  return correlationKeyFor(run.workflowId, run.trigger);
}

/**
 * Is `correlationKey` currently poison-flagged? architecture §6.2: the
 * guard sets `flag: { kind: "poison" }` on the correlation key's MOST
 * RECENT run — so "is this key poison-flagged" reduces to "does the most
 * recent run for this key carry an unresolved (`clearedAt` absent) poison
 * flag," using the already-frozen `RunRecord.flag` field directly rather
 * than a second, parallel poison-tracking store this package would have to
 * invent and keep in sync.
 */
export async function isPoisonFlagged(store: AartStore, workflowId: string, trigger: Pick<Trigger, "id" | "correlationId">): Promise<RunFlag | undefined> {
  const key = correlationKeyFor(workflowId, trigger);
  const runs = await store.runs.list({ workflowId });
  const forKey = runs.filter((r) => keyOf(r) === key).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const mostRecent = forKey[0];
  if (!mostRecent?.flag || mostRecent.flag.kind !== "poison" || mostRecent.flag.clearedAt) return undefined;
  return mostRecent.flag;
}

export interface PoisonCheckOptions {
  maxConsecutiveFailures?: number;
  windowMs?: number;
  now?: Date;
}

/**
 * Counts consecutive `failed` runs for `correlationKey`, most-recent-first,
 * stopping at the first non-`failed` run or one outside `windowMs`. Returns
 * whether the just-completed failure (the caller passes the run that just
 * finished failing) pushes the streak to/past the threshold — the caller
 * (worker/reclaim.ts's failure path, or a direct engine-boundary failure
 * callback) is responsible for actually setting `flag: { kind: "poison" }`
 * on that run via `store.runs.put()` when this returns true; this function
 * only computes the decision, matching this package's pattern of keeping
 * store-mutation call sites explicit rather than hidden inside a "checker."
 */
export async function shouldFlagPoison(store: AartStore, workflowId: string, trigger: Pick<Trigger, "id" | "correlationId">, options: PoisonCheckOptions = {}): Promise<boolean> {
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const windowMs = options.windowMs ?? DEFAULT_POISON_WINDOW_MS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const key = correlationKeyFor(workflowId, trigger);
  const runs = await store.runs.list({ workflowId });
  const forKey = runs.filter((r) => keyOf(r) === key && r.startedAt >= cutoff).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  let consecutive = 0;
  for (const run of forKey) {
    if (run.status !== "failed") break;
    consecutive += 1;
    if (consecutive >= maxConsecutiveFailures) return true;
  }
  return false;
}

/** architecture §6.2: "when job_queue's count of non-terminal (pending) runs exceeds a configurable ceiling, new triggers are shed at intake." `RunStore.list({status: "pending"})` is exactly this — a run is written `pending` immediately at trigger-intake time (architecture §4.1) and only leaves that status once a worker claims it, so counting `pending` RunRecords is the direct, interface-supported way to measure this. */
export async function isOverBackpressureCeiling(store: AartStore, maxPendingRuns: number = DEFAULT_MAX_PENDING_RUNS): Promise<boolean> {
  const pending = await store.runs.list({ status: "pending" });
  return pending.length >= maxPendingRuns;
}
