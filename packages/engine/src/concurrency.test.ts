import type { AartStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import { decideConcurrency, releaseQueuedRuns, resolveConcurrencyKey } from "./concurrency.js";
import { createTestStore, fixtureRun, fixtureWorkflow } from "./test-utils/fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<AartStore> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return store;
}

describe("resolveConcurrencyKey", () => {
  it("returns undefined when the workflow declares no concurrency block", async () => {
    const workflow = fixtureWorkflow();
    expect(await resolveConcurrencyKey(workflow, {})).toBeUndefined();
  });

  it("resolves the {{ }}-expression key against inputs", async () => {
    const workflow = fixtureWorkflow({ concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    expect(await resolveConcurrencyKey(workflow, { caseId: "case-42" })).toBe("case-42");
  });

  it("coerces a non-string resolved key to a string", async () => {
    const workflow = fixtureWorkflow({ concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    expect(await resolveConcurrencyKey(workflow, { caseId: 42 })).toBe("42");
  });
});

describe("decideConcurrency — all four policies (architecture §4.3)", () => {
  it("allow: no concurrency block declared -> always allow", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow();
    expect(await decideConcurrency(store, workflow, undefined)).toEqual({ action: "allow" });
  });

  it("allow: concurrency declared but no existing non-terminal run shares the key -> allow", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-allow", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    expect(await decideConcurrency(store, workflow, "case-1")).toEqual({ action: "allow" });
  });

  it("allow: policy is literally 'allow' even with an existing conflicting run -> allow (no constraint)", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-allow-policy", concurrency: { key: "{{ inputs.caseId }}", policy: "allow" } });
    await store.runs.put(fixtureRun({ workflowId: "wf-allow-policy", status: "running", params: { concurrencyKey: "case-1" } }));
    expect(await decideConcurrency(store, workflow, "case-1")).toEqual({ action: "allow" });
  });

  it("queue: an existing non-terminal run with the same key -> queue, returning the blocking run", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-queue", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    const existing = fixtureRun({ workflowId: "wf-queue", status: "running", params: { concurrencyKey: "case-1" } });
    await store.runs.put(existing);
    const decision = await decideConcurrency(store, workflow, "case-1");
    expect(decision.action).toBe("queue");
    if (decision.action !== "queue") throw new Error("unreachable");
    expect(decision.blockingRun.runId).toBe(existing.runId);
  });

  it("queue: only matches non-terminal statuses (pending/running/waiting) — a completed run with the same key does not block", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-queue2", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    await store.runs.put(fixtureRun({ workflowId: "wf-queue2", status: "completed", params: { concurrencyKey: "case-1" } }));
    expect(await decideConcurrency(store, workflow, "case-1")).toEqual({ action: "allow" });
  });

  it("queue: a DIFFERENT key on an existing run does not block", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-queue3", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    await store.runs.put(fixtureRun({ workflowId: "wf-queue3", status: "running", params: { concurrencyKey: "case-OTHER" } }));
    expect(await decideConcurrency(store, workflow, "case-1")).toEqual({ action: "allow" });
  });

  it("cancel_existing: an existing non-terminal run with the same key -> cancel_existing, returning the existing run", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-cancel", concurrency: { key: "{{ inputs.caseId }}", policy: "cancel_existing" } });
    const existing = fixtureRun({ workflowId: "wf-cancel", status: "waiting", params: { concurrencyKey: "case-1" } });
    await store.runs.put(existing);
    const decision = await decideConcurrency(store, workflow, "case-1");
    expect(decision).toEqual({ action: "cancel_existing", existingRun: existing });
  });

  it("reject_new: an existing non-terminal run with the same key -> reject", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-reject", concurrency: { key: "{{ inputs.caseId }}", policy: "reject_new" } });
    await store.runs.put(fixtureRun({ workflowId: "wf-reject", status: "pending", params: { concurrencyKey: "case-1" } }));
    expect(await decideConcurrency(store, workflow, "case-1")).toEqual({ action: "reject" });
  });
});

describe("releaseQueuedRuns", () => {
  it("releases the oldest queued run sharing workflowId+key onto job_queue", async () => {
    const store = await setup();
    const older = fixtureRun({ workflowId: "wf-1", status: "pending", startedAt: "2026-01-01T00:00:00.000Z", params: { concurrencyKey: "case-1", waitingOnConcurrency: true } });
    const newer = fixtureRun({ workflowId: "wf-1", status: "pending", startedAt: "2026-01-02T00:00:00.000Z", params: { concurrencyKey: "case-1", waitingOnConcurrency: true } });
    await store.runs.put(older);
    await store.runs.put(newer);

    const released = await releaseQueuedRuns(store, "wf-1", "case-1");
    expect(released?.runId).toBe(older.runId);
    expect(released?.params?.waitingOnConcurrency).toBe(false);

    const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimable.map((c) => c.runId)).toContain(older.runId);
    expect(claimable.map((c) => c.runId)).not.toContain(newer.runId); // not yet released
  });

  it("does nothing (returns undefined) when no run is queued for that workflow+key", async () => {
    const store = await setup();
    expect(await releaseQueuedRuns(store, "wf-none", "case-none")).toBeUndefined();
  });

  it("ignores runs not marked waitingOnConcurrency (e.g. a plain pending run that hasn't been claimed yet for an unrelated reason)", async () => {
    const store = await setup();
    await store.runs.put(fixtureRun({ workflowId: "wf-1", status: "pending", params: { concurrencyKey: "case-1" } }));
    expect(await releaseQueuedRuns(store, "wf-1", "case-1")).toBeUndefined();
  });
});
