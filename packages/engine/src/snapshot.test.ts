import type { AartStore } from "@aart/store";
import type { BlockImplementation } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import { captureExecutionSnapshot, isSnapshotCaptured, resolveWorkflowForRun, uncapturedSnapshot } from "./snapshot.js";
import { createTestStore, fixtureRun, fixtureWorkflow } from "./test-utils/fixtures.js";
import type { BlockRegistry } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(): Promise<AartStore> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return store;
}

function block(id: string, version: string): BlockImplementation {
  return { manifest: { id, version, capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" }, execute: async () => ({}) };
}

describe("uncapturedSnapshot / isSnapshotCaptured", () => {
  it("uncapturedSnapshot has capturedAt = '' (the sentinel)", () => {
    expect(uncapturedSnapshot().capturedAt).toBe("");
  });

  it("isSnapshotCaptured is false for the sentinel, true once captured", () => {
    expect(isSnapshotCaptured(uncapturedSnapshot())).toBe(false);
    expect(isSnapshotCaptured({ definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() })).toBe(true);
  });
});

describe("captureExecutionSnapshot (architecture §4.5, spec §19.1)", () => {
  it("captures the resolved Workflow object as `definitions`", async () => {
    const workflow = fixtureWorkflow();
    const snapshot = await captureExecutionSnapshot(workflow, {}, new Date());
    expect(snapshot.definitions).toEqual(workflow);
  });

  it("resolves the concrete version for a floating block reference from the engine's own block registry (this session's DoD test requirement)", async () => {
    const workflow = fixtureWorkflow({
      execution: { type: "workflow", steps: [{ id: "s1", uses: "browser.click" }, { id: "s2", uses: "http.request" }] },
    });
    const blocks: BlockRegistry = { "browser.click": block("browser.click", "2.3.1"), "http.request": block("http.request", "1.0.0") };
    const snapshot = await captureExecutionSnapshot(workflow, blocks, new Date());
    expect(snapshot.resolvedVersions).toEqual({ "browser.click": "2.3.1", "http.request": "1.0.0" });
  });

  it("omits a step's block id from resolvedVersions when it isn't in the registry (e.g. a wait-block id, handled structurally rather than via a registered BlockImplementation)", async () => {
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "wait.manual" }] } });
    const snapshot = await captureExecutionSnapshot(workflow, {}, new Date());
    expect(snapshot.resolvedVersions).toEqual({});
  });

  it("sets capturedAt to the given now()", async () => {
    const now = new Date("2027-03-01T12:00:00.000Z");
    const snapshot = await captureExecutionSnapshot(fixtureWorkflow(), {}, now);
    expect(snapshot.capturedAt).toBe("2027-03-01T12:00:00.000Z");
  });

  it("packHashes defaults to an empty record when no computePackHashes is injected (S9 reconciliation ledger item 8's default)", async () => {
    const snapshot = await captureExecutionSnapshot(fixtureWorkflow(), {}, new Date());
    expect(snapshot.packHashes).toEqual({});
  });

  it("packHashes uses the injected computePackHashes function when supplied", async () => {
    const workflow = fixtureWorkflow();
    const snapshot = await captureExecutionSnapshot(workflow, {}, new Date(), async () => ({ "some-pack": "sha256:abc123" }));
    expect(snapshot.packHashes).toEqual({ "some-pack": "sha256:abc123" });
  });
});

describe("resolveWorkflowForRun", () => {
  it("falls back to the live store.workflows entry when no snapshot has been captured yet", async () => {
    const store = await setup();
    const workflow = fixtureWorkflow({ id: "wf-live", version: "1.0.0" });
    await store.workflows.put(workflow);
    const run = fixtureRun({ workflowId: "wf-live", workflowVersion: "1.0.0", snapshot: uncapturedSnapshot() });
    const resolved = await resolveWorkflowForRun(store, run);
    expect(resolved).toEqual(workflow);
  });

  it("prefers the run's OWN captured snapshot over a newer live store version (architecture §4.5: the snapshot is frozen apart from the store's 'as it is now' world)", async () => {
    const store = await setup();
    const originalWorkflow = fixtureWorkflow({ id: "wf-versioned", version: "1.0.0", name: "Original" });
    const editedLiveWorkflow = fixtureWorkflow({ id: "wf-versioned", version: "1.0.0", name: "Edited after the run started" });
    await store.workflows.put(editedLiveWorkflow); // the store now has the EDITED version

    const run = fixtureRun({
      workflowId: "wf-versioned",
      workflowVersion: "1.0.0",
      snapshot: { definitions: originalWorkflow, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
    });
    const resolved = await resolveWorkflowForRun(store, run);
    expect(resolved.name).toBe("Original"); // NOT "Edited after the run started"
  });

  it("throws a clear error when no snapshot exists AND the store has no matching workflow (a genuinely broken reference)", async () => {
    const store = await setup();
    const run = fixtureRun({ workflowId: "does-not-exist", workflowVersion: "9.9.9", snapshot: uncapturedSnapshot() });
    await expect(resolveWorkflowForRun(store, run)).rejects.toThrow(/no workflow found/i);
  });
});
