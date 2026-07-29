// event-log.ts's own unit tests — previously untested directly (only
// exercised transitively through the ~21 real call sites across
// mcp/server/cli). Added by the D2b/V1 fix pass (AMENDMENTS.md A63, FIX 5)
// alongside the best-effort-contract fix below, so the contract this
// module's own doc comment promises ("never fails the primary operation")
// is verified directly, not just asserted in prose.
import { describe, expect, it } from "vitest";
import type { EventLogEntry } from "@aart/types";
import { recordEvent, recordRunTerminalEvent } from "./event-log.js";
import type { AartStore } from "./types.js";

/** A minimal, in-memory `Pick<AartStore, "events">`-shaped fake (note: WRAPPED under an `events` key, matching `recordEvent`'s own `store: Pick<AartStore, "events">` parameter — recordEvent reads `store.events.append`, not `store.append`) — recordEvent's own signature needs nothing more than this, so no real fs/sqlite store is spun up for these tests. */
function fakeEventsStore(): { store: Pick<AartStore, "events">; appended: EventLogEntry[] } {
  const appended: EventLogEntry[] = [];
  return {
    appended,
    store: {
      events: {
        append: async (entry: EventLogEntry) => {
          appended.push(entry);
        },
        replaceAudit: async (eventId, audit) => {
          const index = appended.findIndex((candidate) => candidate.id === eventId);
          const current = appended[index];
          if (index !== -1 && current) {
            appended[index] = { ...current, ...audit };
          }
        },
        list: async () => appended,
      },
    },
  };
}

describe("recordEvent (V1 event log foundation, AMENDMENTS.md A61)", () => {
  it("appends an entry with a fresh id/occurredAt filled in when both are omitted", async () => {
    const { store, appended } = fakeEventsStore();
    await recordEvent(store, { type: "run.started", summary: "s" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.id).toEqual(expect.any(String));
    expect(appended[0]?.occurredAt).toEqual(expect.any(String));
    expect(appended[0]?.type).toBe("run.started");
    expect(appended[0]?.summary).toBe("s");
  });

  it("honors an explicitly-supplied id/occurredAt rather than generating its own (tests that need determinism)", async () => {
    const { store, appended } = fakeEventsStore();
    await recordEvent(store, { id: "evt_fixed", occurredAt: "2026-01-01T00:00:00.000Z", type: "run.started", summary: "s" });
    expect(appended[0]).toMatchObject({ id: "evt_fixed", occurredAt: "2026-01-01T00:00:00.000Z" });
  });

  it("a correlation field omitted stays genuinely absent, never a stray populated value", async () => {
    const { store, appended } = fakeEventsStore();
    await recordEvent(store, { type: "eval.suite_created", summary: "s" });
    expect(appended[0]).toEqual({ id: expect.any(String), occurredAt: expect.any(String), type: "eval.suite_created", summary: "s" });
  });

  it("a throwing store.events.append is swallowed — the returned promise resolves, never rejects (best-effort contract)", async () => {
    const store = {
      events: {
        append: async () => { throw new Error("disk full"); },
        replaceAudit: async () => undefined,
        list: async () => [],
      },
    };
    await expect(recordEvent(store, { type: "run.started", summary: "s" })).resolves.toBeUndefined();
  });

  // AMENDMENTS.md A63 FIX 5 — the actual bug this fix closes. Pre-fix, the
  // `entry` object (including `now()`) was constructed OUTSIDE the
  // try/catch, so a throwing clock rejected this function's own promise
  // instead of being absorbed like every other failure mode. Every one of
  // the ~21 real `await recordEvent(...)` call sites across this codebase
  // relies on this function NEVER rejecting — a caller passing a clock
  // that can throw (or any future caller of this exported function) would
  // have propagated that throw straight into its own caller, contradicting
  // this module's own "never fails the primary operation" doc comment.
  it("a throwing now()/clock does NOT reject — the primary operation stays unaffected (AMENDMENTS.md A63 FIX 5)", async () => {
    const { store, appended } = fakeEventsStore();
    const throwingNow = (): Date => {
      throw new Error("clock broke");
    };
    await expect(recordEvent(store, { type: "run.started", summary: "s" }, throwingNow)).resolves.toBeUndefined();
    expect(appended).toHaveLength(0); // the append never happened (the entry was never even constructed) -- still not a rejection
  });

  it("a throwing now() does not affect a LATER, healthy recordEvent call on the same store (no leaked bad state)", async () => {
    const { store, appended } = fakeEventsStore();
    const throwingNow = (): Date => {
      throw new Error("clock broke");
    };
    await recordEvent(store, { type: "run.started", summary: "first, throws" }, throwingNow);
    await recordEvent(store, { type: "run.completed", summary: "second, healthy" });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.summary).toBe("second, healthy");
  });
});

describe("recordRunTerminalEvent", () => {
  function fakeStoreWithRun(run: { runId: string; status: string; workflowId: string; workflowVersion: string } | undefined): { store: AartStore; appended: EventLogEntry[] } {
    const appended: EventLogEntry[] = [];
    const store = {
      runs: { get: async (id: string) => (run && run.runId === id ? run : undefined) },
      events: {
        append: async (entry: EventLogEntry) => {
          appended.push(entry);
        },
        list: async () => appended,
      },
    } as unknown as AartStore;
    return { store, appended };
  }

  it("maps completed/failed/cancelled to the matching event type", async () => {
    const { store, appended } = fakeStoreWithRun({ runId: "run_1", status: "failed", workflowId: "wf_1", workflowVersion: "1.0.0" });
    await recordRunTerminalEvent(store, "run_1");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("run.failed");
    expect(appended[0]?.runId).toBe("run_1");
  });

  it("a non-terminal or missing run is a silent no-op, not a throw", async () => {
    const { store: missingStore } = fakeStoreWithRun(undefined);
    await expect(recordRunTerminalEvent(missingStore, "no-such-run")).resolves.toBeUndefined();

    const { store: runningStore, appended } = fakeStoreWithRun({ runId: "run_2", status: "running", workflowId: "wf_1", workflowVersion: "1.0.0" });
    await recordRunTerminalEvent(runningStore, "run_2");
    expect(appended).toHaveLength(0);
  });

  it("a throwing store.runs.get is swallowed by its own outer try/catch, not just recordEvent's inner one", async () => {
    const store = { runs: { get: async () => { throw new Error("read failed"); } }, events: { append: async () => {}, list: async () => [] } } as unknown as AartStore;
    await expect(recordRunTerminalEvent(store, "run_x")).resolves.toBeUndefined();
  });
});
