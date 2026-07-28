// Concurrency policies (architecture §4.3, spec §30.1). Enforcement point:
// "at trigger time, before a new RunRecord is written as pending, the
// engine's trigger-intake path resolves the concurrency key and checks the
// store for other non-terminal (pending/running/waiting) runs of the same
// workflow+key." This module is that check, plus the `queue` policy's
// release-on-completion hook (`releaseQueuedRuns`, called by
// `run-lifecycle.ts` whenever a run reaches a terminal status).
import { resolveExpression } from "@aart/expr";
import type { AartStore } from "@aart/store";
import type { RunRecord, Workflow } from "@aart/types";
import { createHash } from "node:crypto";

const NON_TERMINAL_STATUSES = new Set<RunRecord["status"]>(["pending", "running", "waiting"]);
export const CONCURRENCY_KEY_FORMAT = "sha256-v1";

/** Stable, non-reversible representation used by tagged records and diagnostics. */
export function fingerprintConcurrencyKey(key: string | undefined): string | undefined {
  return key === undefined ? undefined : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function normalizePersistedKey(key: string | undefined, format: unknown): string | undefined {
  if (key === undefined) return undefined;
  // Never infer storage format from the value's shape: an authored key can
  // itself legitimately look like "sha256:<64 hex>". Tagged records carry
  // the fingerprint format explicitly; marker-less records remain the
  // backward-readable raw form and are fingerprinted once for comparison.
  return format === CONCURRENCY_KEY_FORMAT ? key : fingerprintConcurrencyKey(key);
}

function persistedConcurrencyKey(run: RunRecord): string | undefined {
  return normalizePersistedKey(run.params?.concurrencyKey as string | undefined, run.params?.concurrencyKeyFormat);
}

function concurrencyKeysEqual(run: RunRecord, key: string | undefined, keyFormat: unknown): boolean {
  return persistedConcurrencyKey(run) === normalizePersistedKey(key, keyFormat);
}

/** Resolves `workflow.concurrency.key` (architecture §4.3, `{{ }}` against `inputs.*`) — `undefined` if the workflow declares no `concurrency` block at all (the "no constraint" default, equivalent to `policy: "allow"`). */
export async function resolveConcurrencyKey(workflow: Workflow, inputs: Record<string, unknown>): Promise<string | undefined> {
  if (!workflow.concurrency) return undefined;
  const resolved = await resolveExpression(workflow.concurrency.key, { inputs });
  return typeof resolved === "string" ? resolved : String(resolved);
}

export type ConcurrencyDecision =
  | { action: "allow" }
  | { action: "queue"; blockingRun: RunRecord }
  | { action: "cancel_existing"; existingRun: RunRecord }
  | { action: "reject" };

/**
 * The trigger-intake decision (architecture §4.3's four policies). Looks up
 * every non-terminal run of `workflow.id` and compares `params.concurrencyKey`
 * (a backward-readable raw key or tagged fingerprint, normalized on read)
 * against the newly-resolved raw authored key. `decideConcurrency` is public beside
 * `resolveConcurrencyKey`, so it preserves that raw-key contract and performs
 * fingerprinting internally. Returns `{ action: "allow" }`
 * when the workflow declares no `concurrency` block, or when no other
 * non-terminal run shares this exact key.
 */
export async function decideConcurrency(store: AartStore, workflow: Workflow, rawKey: string | undefined): Promise<ConcurrencyDecision> {
  if (!workflow.concurrency || rawKey === undefined) {
    return { action: "allow" };
  }
  const candidates = await store.runs.list({ workflowId: workflow.id });
  const existing = candidates.find(
    (r) => NON_TERMINAL_STATUSES.has(r.status) && concurrencyKeysEqual(r, rawKey, undefined),
  );
  if (!existing) {
    return { action: "allow" };
  }
  switch (workflow.concurrency.policy) {
    case "allow":
      return { action: "allow" };
    case "queue":
      return { action: "queue", blockingRun: existing };
    case "cancel_existing":
      return { action: "cancel_existing", existingRun: existing };
    case "reject_new":
      return { action: "reject" };
    default: {
      const exhaustiveCheck: never = workflow.concurrency.policy;
      throw new Error(`Unhandled ConcurrencyPolicy: ${exhaustiveCheck}`);
    }
  }
}

/**
 * Called whenever a run reaches a terminal status (`run-lifecycle.ts`) —
 * finds the oldest still-`pending`, still-queued (`params.waitingOnConcurrency
 * === true`) run sharing this workflow+key, if any, and releases it onto
 * `job_queue` so a worker can claim it. `[DECISION]` releases at most ONE
 * queued run per completion (not every queued run at once) — `queue`'s
 * whole point (spec §30.1) is serializing runs of the same key, so releasing
 * more than one at a time would defeat it; the newly-released run's own
 * eventual completion will in turn release the next one in line (FIFO by
 * `startedAt`).
 */
export async function releaseQueuedRuns(
  store: AartStore,
  workflowId: string,
  key: string,
  keyFormat: unknown,
): Promise<RunRecord | undefined> {
  const candidates = await store.runs.list({ workflowId, status: "pending" });
  const queued = candidates
    .filter(
      (r) => r.params?.waitingOnConcurrency === true && concurrencyKeysEqual(r, key, keyFormat),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const next = queued[0];
  if (!next) return undefined;
  const released: RunRecord = { ...next, params: { ...next.params, waitingOnConcurrency: false } };
  await store.runs.put(released);
  await store.jobQueue.enqueue(released.runId);
  return released;
}
