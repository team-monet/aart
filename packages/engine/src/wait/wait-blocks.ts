// The fixed wait-block-id vocabulary (architecture §4.4 lifecycle step 1,
// verbatim: "Step dispatches to a wait-type block (wait.for_signal /
// wait.until / wait.for_webhook / wait.for_external_job / wait.for_queue /
// wait.manual / human.approval)") and its 1:1 mapping onto the 7
// `WaitCondition` members (spec §13.3, spec §15.3's Wait/Human block
// groups). This is how the engine recognizes "this step enters a wait"
// WITHOUT needing a `type` discriminant on the frozen `BlockManifest`
// (architecture §2.5) — see this session's final report for the fuller
// design rationale on why this is engine-owned, hardcoded knowledge rather
// than a block-manifest field.
//
// SEAM: `@aart/blocks-core` (S3) MUST register its wait/human block
// implementations under exactly these 7 id strings for the engine to
// recognize them as wait-triggering — recorded in SEAMS.md.
import type { WaitCondition } from "@aart/types";

export const WAIT_BLOCK_IDS = [
  "wait.for_signal",
  "wait.until",
  "wait.for_webhook",
  "wait.for_external_job",
  "wait.for_queue",
  "wait.manual",
  "human.approval",
] as const;
export type WaitBlockId = (typeof WAIT_BLOCK_IDS)[number];

export function isWaitBlockId(blockId: string): blockId is WaitBlockId {
  return (WAIT_BLOCK_IDS as readonly string[]).includes(blockId);
}

function requireString(record: Record<string, unknown>, field: string, blockId: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`${blockId}'s "with.${field}" must resolve to a string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Constructs the `WaitCondition` for any wait-block-id EXCEPT
 * `human.approval` — that one needs an `ApprovalTask.id` minted first
 * (`wait-machine.ts`'s `enterWait` handles it as a special case, since it's
 * the one member requiring a store write before the `WaitCondition` itself
 * can even be built). `resolvedWith` is the step's already-`{{ }}`-resolved
 * `with:` record (architecture §4.2 pipeline step 1).
 */
export function buildWaitConditionFromBlock(
  blockId: Exclude<WaitBlockId, "human.approval">,
  resolvedWith: Record<string, unknown>,
  schemaVersion: number,
): WaitCondition {
  switch (blockId) {
    case "wait.for_signal":
      return {
        type: "signal",
        name: requireString(resolvedWith, "name", blockId),
        correlationId: requireString(resolvedWith, "correlationId", blockId),
        timeout: optionalString(resolvedWith, "timeout"),
        schemaVersion,
      };
    case "wait.until":
      return {
        type: "timer",
        resumeAt: requireString(resolvedWith, "resumeAt", blockId),
        schemaVersion,
      };
    case "wait.for_webhook":
      return {
        type: "webhook",
        event: requireString(resolvedWith, "event", blockId),
        correlationId: requireString(resolvedWith, "correlationId", blockId),
        timeout: optionalString(resolvedWith, "timeout"),
        schemaVersion,
      };
    case "wait.for_external_job":
      return {
        type: "external_job",
        provider: requireString(resolvedWith, "provider", blockId),
        jobId: requireString(resolvedWith, "jobId", blockId),
        timeout: optionalString(resolvedWith, "timeout"),
        schemaVersion,
      };
    case "wait.for_queue":
      return {
        type: "queue",
        queue: requireString(resolvedWith, "queue", blockId),
        correlationId: requireString(resolvedWith, "correlationId", blockId),
        timeout: optionalString(resolvedWith, "timeout"),
        schemaVersion,
      };
    case "wait.manual":
      return {
        type: "manual",
        timeout: optionalString(resolvedWith, "timeout"),
        schemaVersion,
      };
  }
}

/**
 * The `(name, correlationId)` pair `SignalStore` matching keys on (architecture
 * §4.4.2/§5.6), for whichever `WaitCondition` members actually correlate
 * against a `Signal` — `undefined` for the three that never touch
 * `SignalStore` at all (architecture §4.4.1's explicit partition: `timer`,
 * `manual`, `approval`). Written as a fully exhaustive switch (`never` in
 * the default case) per architecture §2.2's explicit requirement on this
 * package's wait handling: "MUST be written so TypeScript's exhaustiveness
 * check... fails to compile if a member is unhandled."
 *
 * `[DECISION]` (documented here since neither source document gives an
 * exact `Signal.name`/`correlationId` convention for `queue`/`external_job`):
 * `queue`'s own `queue` field serves as the name-equivalent (mirroring how
 * `webhook`'s `event` field is explicitly stated to serve that role, spec
 * §13.3); `external_job`'s `provider` field serves as the name-equivalent
 * and `jobId` as the correlationId (matching architecture §4.4.1's own
 * text: the webhook sub-path converts a job-completion event into "a Signal
 * keyed on jobId"). A `Signal` producer (whichever trigger adapter/queue
 * consumer converts an external event into a `Signal`, `@aart/server`'s
 * scope) must populate `Signal.name`/`correlationId` to match this same
 * convention for correlation to actually succeed — flagged in this
 * session's SEAMS.md entry.
 */
export function waitSignalCorrelation(wait: WaitCondition): { name: string; correlationId: string } | undefined {
  switch (wait.type) {
    case "signal":
      return { name: wait.name, correlationId: wait.correlationId };
    case "webhook":
      return { name: wait.event, correlationId: wait.correlationId };
    case "queue":
      return { name: wait.queue, correlationId: wait.correlationId };
    case "external_job":
      return { name: wait.provider, correlationId: wait.jobId };
    case "timer":
    case "manual":
    case "approval":
      return undefined;
    default: {
      const exhaustiveCheck: never = wait;
      throw new Error(`Unhandled WaitCondition member: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
