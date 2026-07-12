// V1 event log foundation (AMENDMENTS.md A61) — the shared write helpers
// every real composition root (packages/mcp/src/handlers/*, packages/
// server/src/*, packages/mcp/src/real-context.ts's/packages/
// familiarity-evals/src/real-checks.ts's EngineConfig.onRunTerminal hooks)
// goes through, so this session's "a failed event-log write must never
// fail the primary operation it's observing" contract is enforced in
// exactly ONE place — never re-implemented (and potentially forgotten) at
// each of the ~15 real write sites.
import { randomUUID } from "node:crypto";
import type { EventLogEntry, RunRecord } from "@aart/types";
import type { AartStore } from "./types.js";

export interface RecordEventInput extends Omit<EventLogEntry, "id" | "occurredAt"> {
  /** Defaults to a fresh randomUUID(). Override only for tests that need a deterministic id. */
  id?: string;
  /** Defaults to `now().toISOString()`. Override only for tests that need a deterministic timestamp. */
  occurredAt?: string;
}

/**
 * Best-effort `EventLogStore.append` — every real write site in this
 * session calls THIS function, never `store.events.append` directly. A
 * thrown error from the append (a full disk, a locked sqlite file, ...) is
 * caught and swallowed here, deliberately silently (no logger call) —
 * mirrors `@aart/engine`'s own established idiom for an identically-scoped
 * best-effort hook (`run-lifecycle.ts`'s `runOnRunTerminal`: "Best-effort:
 * the run's terminal status is already durably persisted; a resource-
 * cleanup hook failing... must never retroactively fail an already-
 * completed/failed/cancelled run" — no logging there either). The primary
 * operation this event is documenting (a run, a deploy, a gate transition,
 * an approval decision, ...) has, in every real call site, ALREADY been
 * durably persisted by the time this is called — this call can fail
 * without leaving the store in an inconsistent state, only a quieter
 * activity feed.
 */
export async function recordEvent(store: Pick<AartStore, "events">, input: RecordEventInput, now: () => Date = () => new Date()): Promise<void> {
  const entry: EventLogEntry = {
    ...input,
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? now().toISOString(),
  };
  try {
    await store.events.append(entry);
  } catch {
    // Best-effort, deliberately swallowed — see doc comment above.
  }
}

const RUN_TERMINAL_EVENT_TYPE = {
  completed: "run.completed",
  failed: "run.failed",
  cancelled: "run.cancelled",
} as const satisfies Partial<Record<RunRecord["status"], string>>;

function isRunTerminalStatus(status: RunRecord["status"]): status is keyof typeof RUN_TERMINAL_EVENT_TYPE {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Shared by every real `EngineConfig.onRunTerminal` composition root
 * (`packages/mcp/src/real-context.ts`'s `createRealEngine`,
 * `packages/familiarity-evals/src/real-checks.ts`'s
 * `createRealRunSuccessFn` — the only two real `createEngine(...)` call
 * sites in this workspace, verified directly, AMENDMENTS.md A61) — RISK 1's
 * fix. `onRunTerminal`'s own signature only carries a `runId`
 * (`run-lifecycle.ts`'s `runOnRunTerminal`), so this re-reads the
 * just-persisted `RunRecord` to recover `workflowId`/`workflowVersion`/
 * `status`: both `finalizeTerminal` AND `cancelRun` (run-lifecycle.ts) call
 * `store.runs.put(redacted)` BEFORE invoking this hook, so the read below
 * always sees the correct terminal status, never a stale pre-terminal one.
 * A run that (defensively — should not happen given that ordering) isn't
 * found, or isn't actually terminal, is a silent no-op, matching this
 * whole mechanism's best-effort contract; wrapped in its own try/catch
 * (belt-and-braces on top of `recordEvent`'s own internal one) since the
 * `store.runs.get` read itself is outside `recordEvent`'s try/catch.
 */
export async function recordRunTerminalEvent(store: AartStore, runId: string, now: () => Date = () => new Date()): Promise<void> {
  try {
    const run = await store.runs.get(runId);
    if (!run || !isRunTerminalStatus(run.status)) return;
    await recordEvent(
      store,
      {
        type: RUN_TERMINAL_EVENT_TYPE[run.status],
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        runId: run.runId,
        summary: `${run.workflowId}@${run.workflowVersion} run ${run.status} (${run.runId})`,
      },
      now,
    );
  } catch {
    // Best-effort — see recordEvent's own doc comment; this extra layer
    // covers the store.runs.get read above, which isn't itself inside
    // recordEvent's try/catch.
  }
}
