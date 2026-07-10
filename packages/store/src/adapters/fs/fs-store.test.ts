// fs-adapter-specific behaviors not covered by the adapter-agnostic
// conformance suite: the documented non-atomic signals-audit-copy gap
// (architecture §5.8), atomic write-temp-then-rename hygiene, and the
// concrete .aart/ directory layout (architecture §5.2).
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AartStore } from "../../types.js";
import { createFsStore } from "./index.js";
import * as paths from "./paths.js";

let root: string;
let store: AartStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-store-fs-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("fs adapter — .aart/ layout (architecture §5.2)", () => {
  it("writes a run under runs/<runId>.json", async () => {
    const run = {
      runId: "run_layout_1",
      workflowId: "wf",
      workflowVersion: "1",
      status: "running" as const,
      approved: true,
      approvalMode: "governed" as const,
      trigger: { type: "manual" as const, id: "t1", source: "cli", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 1,
    };
    await store.runs.put(run);
    const onDisk = await fs.readFile(join(paths.runsDir(root), "run_layout_1.json"), "utf8");
    expect(JSON.parse(onDisk).record.runId).toBe("run_layout_1");
  });

  it("writes a workflow under registry/workflows/<workflowId>/<version>.json", async () => {
    await store.workflows.put({
      id: "wf_layout",
      name: "n",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "draft",
      gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    });
    const onDisk = await fs.readFile(join(paths.registryWorkflowsDir(root), "wf_layout", "0.1.0.json"), "utf8");
    expect(JSON.parse(onDisk).id).toBe("wf_layout");
  });

  it("leaves no .tmp- files behind after a successful write (write-temp-then-rename hygiene)", async () => {
    await store.approvals.put({ id: "at_1", runId: "run_1", stepId: "s1", title: "t", description: "d", status: "pending", createdAt: new Date().toISOString() });
    const entries = await fs.readdir(paths.approvalsDir(root));
    expect(entries.every((f) => !f.startsWith(".tmp-"))).toBe(true);
    expect(entries).toContain("at_1.json");
  });
});

describe("fs adapter — documented non-atomic gap: the global signals audit copy (architecture §5.8)", () => {
  it("marks the signals audit copy consumed even when the surrounding transact() callback later throws — signals writes are NOT staged/rolled-back", async () => {
    const signal = { id: "sig_gap_1", name: "quote.received", correlationId: "corr_gap_1", payload: {}, receivedAt: new Date().toISOString() };
    await store.signals.append(signal);

    await expect(
      store.transact(async (tx) => {
        // A real caller would also update run state here; this test isolates
        // the documented gap by having the transaction touch `signals`
        // (not staged) and then fail before anything staged would commit.
        await tx.signals.markConsumed(signal.id);
        throw new Error("simulated crash after the (unstaged) signals write, before the transaction would otherwise commit");
      }),
    ).rejects.toThrow();

    // The signals audit copy's consumed flag is NOT rolled back — this is
    // the accepted, documented gap (architecture §5.8): "under fs, a crash
    // between the two could leave a consumed signal's audit copy showing
    // consumed:false even though the run already advanced (or, much less
    // likely, vice versa)."
    await expect(store.signals.findUnconsumedMatch("quote.received", "corr_gap_1")).resolves.toBeUndefined();
  });
});

describe("fs adapter — signals directory layout", () => {
  it("writes a signal under signals/<correlationId>__<receivedAt>.json", async () => {
    const receivedAt = new Date().toISOString();
    await store.signals.append({ id: "sig_layout", name: "n", correlationId: "corr_layout", payload: {}, receivedAt });
    const entries = await fs.readdir(paths.signalsDir(root));
    expect(entries.some((f) => f.startsWith("corr_layout__"))).toBe(true);
  });
});
