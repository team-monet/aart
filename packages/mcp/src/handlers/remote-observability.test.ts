// aart_remote_status / aart_remote_why / aart_remote_runs / aart_remote_run —
// D2b "remote reads" (AMENDMENTS.md, this session). Every test stands up a
// REAL @aart/server `startServer` instance as the "remote" (not a hand-
// rolled fake mimicking these routes' response shapes) — the same
// "against a REAL @aart/server instance" discipline
// packages/dashboard/src/api-client.test.ts already established for its own
// HTTP client tests, chosen here for the identical reason: these four tools
// read SIX different real routes (GET /workflows/:id, /deployments,
// /environments, /approvals, /runs, /runs/:id), and a hand-mocked server
// covering all six would risk silently drifting from what those routes
// actually return.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEngine, startServer, systemClock, type ServerHandle } from "@aart/server";
import { createFsStore, type AartStore } from "@aart/store";
import type { ApprovalTask, Deployment, Environment, RunRecord, Workflow } from "@aart/types";
import type { TestContext } from "../test-utils.js";
import { createTestContext } from "../test-utils.js";
import { remoteRunHandler, remoteRunsHandler, remoteStatusHandler, remoteWhyHandler } from "./remote-observability.js";

let tc: TestContext;
let remote: { store: AartStore; url: string; handle: ServerHandle; root: string } | undefined;
afterEach(async () => {
  await tc?.cleanup();
  if (remote) {
    await remote.handle.close();
    await fs.rm(remote.root, { recursive: true, force: true });
  }
  remote = undefined;
});

/** A real `@aart/server` instance (real fs-backed store, `createFakeEngine`, no ticker) standing in for a deployed remote — see this file's own module doc comment for why. */
async function startRemoteServer(deployToken?: string): Promise<{ store: AartStore; url: string; handle: ServerHandle; root: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-remote-obs-test-"));
  const store = createFsStore(root);
  const engine = createFakeEngine(store, systemClock);
  const handle = await startServer({ store, engine, clock: systemClock, port: 0, runTicker: false, deployToken });
  remote = { store, url: `http://127.0.0.1:${handle.port}`, handle, root };
  return remote;
}

/**
 * Mirrors `deployment.test.ts`'s own `writeRemote` helper (that file's own
 * local convention — not exported, so reproduced here rather than imported)
 * with ONE fix: MERGES into any existing `remotes.json` instead of
 * overwriting it wholesale. `deployment.test.ts`'s own version never needed
 * this (none of its tests register more than one remote per test root) —
 * this file's own multi-remote `aart_remote_status` test does, and a bare
 * overwrite would silently drop every remote registered before the last
 * `writeRemote` call in the same test.
 */
async function writeRemote(root: string, name: string, entry: { url: string; environment: string; tokenRef?: string }): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const path = join(root, "remotes.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  await fs.writeFile(path, JSON.stringify({ ...existing, [name]: entry }), "utf8");
}

let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Mirrors `packages/server/src/http/server.test.ts`'s own `fixtureWorkflow`/`deployableWorkflow` and `packages/dashboard/src/test-support/fixtures.ts`'s own `makeWorkflow` — the same minimal-valid-Workflow shape reproduced a third time (no shared cross-package test-fixture module exists in this codebase to import from instead). */
function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? uniq("wf"),
    name: "Test Workflow",
    version: "1.0.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return { id: overrides.id ?? uniq("env"), name: "staging", config: {}, ...overrides };
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: overrides.id ?? uniq("dep"),
    workflowId: overrides.workflowId ?? "wf",
    workflowVersion: overrides.workflowVersion ?? "1.0.0",
    environmentId: overrides.environmentId ?? "env",
    triggerConfig: {},
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    runId: overrides.runId ?? uniq("run"),
    workflowId: overrides.workflowId ?? "wf-1",
    workflowVersion: overrides.workflowVersion ?? "1.0.0",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: { type: "manual", id: "t1", source: "test", payload: {}, receivedAt: now },
    inputs: {},
    trace: [{ seq: 0, stepId: "s1", block: "http.get", status: "completed", inputs: {}, outputs: {}, startedAt: now }],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: now },
    startedAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// aart_remote_status
// ---------------------------------------------------------------------------

describe("remoteStatusHandler (aart_remote_status)", () => {
  it("fails cleanly when the workflow isn't registered locally", async () => {
    tc = await createTestContext();
    const result = await remoteStatusHandler(tc.ctx, { workflowId: "no-such-workflow" });
    expect(result.ok).toBe(false);
  });

  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put(makeWorkflow({ id: "wf-status-1" }));
    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-1", remote: "no-such-remote" });
    expect(result.ok).toBe(true); // the OVERALL call still succeeds -- the failure is scoped to that one remote's row
    const remotes = result.remotes as Array<{ remote: string; reachable: boolean; error?: string }>;
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.reachable).toBe(false);
    expect(remotes[0]?.error).toMatch(/aart remote add/i);
  });

  it("iterates every configured remote when `remote` is omitted; an unreachable one gets its own row without hiding the others", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put(makeWorkflow({ id: "wf-status-multi", version: "1.0.0" }));
    const live = await startRemoteServer();
    await writeRemote(tc.root, "unreachable", { url: "http://localhost:1", environment: "x" }); // port 1: reserved/unreachable
    await writeRemote(tc.root, "live", { url: live.url, environment: "staging" });

    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-multi" });
    expect(result.ok).toBe(true);
    const rows = result.remotes as Array<{ remote: string; reachable: boolean }>;
    expect(rows.map((r) => r.remote).sort()).toEqual(["live", "unreachable"]);
    expect(rows.find((r) => r.remote === "unreachable")?.reachable).toBe(false);
    expect(rows.find((r) => r.remote === "live")?.reachable).toBe(true);
  });

  it("same version, identical gates/approval -> versionsMatch true, gateDiff empty", async () => {
    tc = await createTestContext();
    const gates = { validate: "passed", readiness: "passed", evals: "pending", riskReview: "pending", humanReview: "pending" } as const;
    await tc.ctx.store.workflows.put(makeWorkflow({ id: "wf-status-match", version: "2.0.0", approval: "approved", gates }));
    const live = await startRemoteServer();
    await live.store.workflows.put(makeWorkflow({ id: "wf-status-match", version: "2.0.0", approval: "approved", gates }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-match", remote: "r1" });
    const row = (result.remotes as Array<{ versionsMatch?: boolean; gateDiff?: unknown[] }>)[0]!;
    expect(row.versionsMatch).toBe(true);
    expect(row.gateDiff).toEqual([]);
  });

  it("same version, DIFFERENT gate/approval state -> gateDiff surfaces exactly the differing fields, field-by-field (not just a version-equality check)", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put(
      makeWorkflow({
        id: "wf-status-diff",
        version: "3.0.0",
        approval: "approved",
        gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
      }),
    );
    const live = await startRemoteServer();
    await live.store.workflows.put(
      makeWorkflow({
        id: "wf-status-diff",
        version: "3.0.0", // SAME version string
        approval: "draft", // different
        gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "pending" }, // humanReview differs
      }),
    );
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-diff", remote: "r1" });
    const row = (result.remotes as Array<{ versionsMatch?: boolean; gateDiff?: Array<{ field: string; local: unknown; remote: unknown }> }>)[0]!;
    expect(row.versionsMatch).toBe(true); // same version string
    expect(row.gateDiff?.map((d) => d.field).sort()).toEqual(["approval", "gates.humanReview"]);
    expect(row.gateDiff?.find((d) => d.field === "approval")).toEqual({ field: "approval", local: "approved", remote: "draft" });
  });

  it("workflow never pushed to the remote -> remoteWorkflow undefined, reachable stays true, NOT reported as an error", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put(makeWorkflow({ id: "wf-status-never-pushed" }));
    const live = await startRemoteServer();
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-never-pushed", remote: "r1" });
    const row = (result.remotes as Array<{ reachable: boolean; error?: string; remoteWorkflow?: unknown }>)[0]!;
    expect(row.reachable).toBe(true);
    expect(row.error).toBeUndefined();
    expect(row.remoteWorkflow).toBeUndefined();
  });

  it("deployments in the row are filtered to the requested workflowId only", async () => {
    tc = await createTestContext();
    await tc.ctx.store.workflows.put(makeWorkflow({ id: "wf-status-deps" }));
    const live = await startRemoteServer();
    await live.store.deployments.put(makeDeployment({ workflowId: "wf-status-deps", environmentId: "env-a" }));
    await live.store.deployments.put(makeDeployment({ workflowId: "some-other-workflow", environmentId: "env-a" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteStatusHandler(tc.ctx, { workflowId: "wf-status-deps", remote: "r1" });
    const row = (result.remotes as Array<{ deployments: Array<{ environmentId: string }> }>)[0]!;
    expect(row.deployments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// aart_remote_why
// ---------------------------------------------------------------------------

describe("remoteWhyHandler (aart_remote_why)", () => {
  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestContext();
    const result = await remoteWhyHandler(tc.ctx, { remote: "no-such-remote", workflowId: "wf" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("environment not registered on the remote -> live:false with a clear, non-error note", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" }); // "staging" never registered on `live`

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-1" });
    expect(result.ok).toBe(true);
    expect(result.live).toBe(false);
    expect(result.note).toMatch(/not registered/i);
  });

  it("nothing ever pushed -> live:false, empty deployments", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.environments.put(makeEnvironment({ id: "env-why-2", name: "staging" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-2" });
    expect(result.ok).toBe(true);
    expect(result.live).toBe(false);
    expect(result.deployments).toEqual([]);
  });

  it("pushed but not promoted (promoted:false) -> live:false, the dormant row is still visible in deployments", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.environments.put(makeEnvironment({ id: "env-why-3", name: "staging" }));
    await live.store.deployments.put(makeDeployment({ workflowId: "wf-why-3", environmentId: "env-why-3", promoted: false }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-3" });
    expect(result.ok).toBe(true);
    expect(result.live).toBe(false);
    expect((result.deployments as Deployment[])).toHaveLength(1);
    expect(result.note).toMatch(/not.*promoted|dormant/i);
  });

  it("a live (promoted) deployment: live:true with liveVersion/promoted/bundleHash/pushedAt/gates/approval all correctly populated -- via the REAL findCurrentVersion tie-break, not a re-derived heuristic", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.environments.put(makeEnvironment({ id: "env-why-4", name: "staging" }));
    await live.store.workflows.put(
      makeWorkflow({ id: "wf-why-4", version: "1.0.0", approval: "approved", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } }),
    );
    await live.store.deployments.put(
      makeDeployment({ workflowId: "wf-why-4", workflowVersion: "1.0.0", environmentId: "env-why-4", bundleHash: "sha256:abc123", createdAt: "2026-07-11T00:00:00.000Z" }),
    );
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-4" });
    expect(result.ok).toBe(true);
    expect(result.live).toBe(true);
    expect(result.liveVersion).toBe("1.0.0");
    expect(result.promoted).toBe(true);
    expect(result.bundleHash).toBe("sha256:abc123");
    expect(result.pushedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(result.approval).toBe("approved");
    expect((result.gates as { humanReview: string }).humanReview).toBe("passed");
  });

  it("who-approved: an ApprovalTask decoding to this workflowId/version/gate surfaces reviewer/authenticatedAs/decidedAt", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.environments.put(makeEnvironment({ id: "env-why-5", name: "staging" }));
    await live.store.workflows.put(makeWorkflow({ id: "wf-why-5", version: "1.0.0" }));
    await live.store.deployments.put(makeDeployment({ workflowId: "wf-why-5", workflowVersion: "1.0.0", environmentId: "env-why-5" }));
    // The SAME sentinel encoding /approvals/:id/decision itself writes
    // through (governance's real workflowVersionApprovalSubject) -- using
    // ctx.governance here (not a hand-rolled runId/stepId string) so this
    // test can't silently drift from the real encoding.
    const { runId, stepId } = tc.ctx.governance.workflowVersionApprovalSubject("wf-why-5", "1.0.0", "humanReview");
    const task: ApprovalTask = {
      id: "task-1",
      runId,
      stepId,
      title: "t",
      description: "d",
      status: "approved",
      reviewer: "alice",
      authenticatedAs: "deploy-token",
      createdAt: "2026-07-10T00:00:00.000Z",
      decidedAt: "2026-07-10T01:00:00.000Z",
    };
    await live.store.approvals.put(task);
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-5" });
    expect(result.ok).toBe(true);
    expect(result.live).toBe(true);
    const approvals = result.approvals as Array<{ gate: string; reviewer?: string; authenticatedAs?: string; decidedAt?: string }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toEqual({ gate: "humanReview", reviewer: "alice", authenticatedAs: "deploy-token", decidedAt: "2026-07-10T01:00:00.000Z", status: "approved" });
  });

  it("whoPushed/whoPromoted are always null, with an explicit not-tracked attribution note -- never guessed", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.environments.put(makeEnvironment({ id: "env-why-6", name: "staging" }));
    await live.store.workflows.put(makeWorkflow({ id: "wf-why-6", version: "1.0.0" }));
    await live.store.deployments.put(makeDeployment({ workflowId: "wf-why-6", workflowVersion: "1.0.0", environmentId: "env-why-6" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteWhyHandler(tc.ctx, { remote: "r1", workflowId: "wf-why-6" });
    expect(result.whoPushed).toBeNull();
    expect(result.whoPromoted).toBeNull();
    expect(typeof result.attributionNote).toBe("string");
    expect((result.attributionNote as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// aart_remote_runs
// ---------------------------------------------------------------------------

describe("remoteRunsHandler (aart_remote_runs)", () => {
  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestContext();
    const result = await remoteRunsHandler(tc.ctx, { remote: "no-such-remote" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("returns a COMPACT summary, never the full trace/inputs/outputs/artifacts/snapshot", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.runs.put(makeRun({ runId: "run-compact-1" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteRunsHandler(tc.ctx, { remote: "r1" });
    expect(result.ok).toBe(true);
    const runs = result.runs as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(Object.keys(run).sort()).toEqual(["headline", "runId", "startedAt", "status", "updatedAt", "workflowId", "workflowVersion"].sort());
    expect(run["trace"]).toBeUndefined();
    expect(run["inputs"]).toBeUndefined();
    expect(run["snapshot"]).toBeUndefined();
  });

  it("status filter is passed through to the remote's own server-side ?status= filter", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.runs.put(makeRun({ runId: "run-status-a", status: "completed" }));
    await live.store.runs.put(makeRun({ runId: "run-status-b", status: "failed", error: "boom" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteRunsHandler(tc.ctx, { remote: "r1", status: "failed" });
    const runs = result.runs as Array<{ runId: string }>;
    expect(runs.map((r) => r.runId)).toEqual(["run-status-b"]);
  });

  it("headline: a failed run gets 'failed: <error>'; other statuses report the bare status", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await live.store.runs.put(makeRun({ runId: "run-headline-failed", status: "failed", error: "assertion mismatch on step 'check'" }));
    await live.store.runs.put(makeRun({ runId: "run-headline-completed", status: "completed" }));
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteRunsHandler(tc.ctx, { remote: "r1" });
    const runs = result.runs as Array<{ runId: string; headline: string }>;
    expect(runs.find((r) => r.runId === "run-headline-failed")?.headline).toBe("failed: assertion mismatch on step 'check'");
    expect(runs.find((r) => r.runId === "run-headline-completed")?.headline).toBe("completed");
  });

  it("an unreachable remote fails cleanly with the standard remedy", async () => {
    tc = await createTestContext();
    await writeRemote(tc.root, "broken", { url: "http://localhost:1", environment: "x" });
    const result = await remoteRunsHandler(tc.ctx, { remote: "broken" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach remote/i);
  });
});

// ---------------------------------------------------------------------------
// aart_remote_run — the redaction/report-rendering seam.
// ---------------------------------------------------------------------------

describe("remoteRunHandler (aart_remote_run)", () => {
  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestContext();
    const result = await remoteRunHandler(tc.ctx, { remote: "no-such-remote", runId: "run-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("run not found on the remote -> a specific, clear failure (not a generic HTTP 404 string)", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const result = await remoteRunHandler(tc.ctx, { remote: "r1", runId: "no-such-run" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.error).toContain("r1");
  });

  // THE REDACTION SEAM (this session's own brief: "confirm aart_remote_run
  // routes through ctx.evidence render, not raw"). Proven two ways: (1) the
  // returned `report` deep-equals what `ctx.evidence.modelFacingReport`
  // computes directly against the IDENTICAL RunRecord -- the exact same
  // pipeline `aart_get_report` (execution.ts) uses for a LOCAL run; (2) the
  // returned `report` has none of RunRecord's own distinguishing raw fields
  // (`trace`/`runId`/`snapshot`) -- a raw pass-through would have kept them,
  // a real ModelFacingReport render never carries them at all
  // (@aart/types' report.ts: headline/workflowId/workflowVersion/failures/
  // artifactRefs/next only).
  it("routes the remote-fetched RunRecord through ctx.evidence.modelFacingReport -- the EXACT same render path aart_get_report uses locally, never a second way to render a run", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const run = makeRun({ runId: "run-render-1", workflowId: "wf-render", status: "completed" });
    await live.store.runs.put(run);
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const expectedReport = tc.ctx.evidence.modelFacingReport(run);

    const result = await remoteRunHandler(tc.ctx, { remote: "r1", runId: "run-render-1" });
    expect(result.ok).toBe(true);
    expect(result.report).toEqual(expectedReport);
    // Shape proof, independent of the deep-equal above: a ModelFacingReport
    // (@aart/types report.ts) never carries these RunRecord-only fields.
    expect(result.report).not.toHaveProperty("trace");
    expect(result.report).not.toHaveProperty("runId");
    expect(result.report).not.toHaveProperty("snapshot");
    expect((result.report as { headline: string }).headline).toMatch(/^(passed|failed|waiting)$/);
  });

  it("format: 'markdown' additionally includes ctx.evidence.markdownReport's rendering, matching the local aart_get_report convention exactly", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const run = makeRun({ runId: "run-render-2", status: "completed" });
    await live.store.runs.put(run);
    await writeRemote(tc.root, "r1", { url: live.url, environment: "staging" });

    const expectedMarkdown = tc.ctx.evidence.markdownReport(run);
    const result = await remoteRunHandler(tc.ctx, { remote: "r1", runId: "run-render-2", format: "markdown" });
    expect(result.ok).toBe(true);
    expect(result.markdown).toBe(expectedMarkdown);
  });

  it("an unreachable remote fails cleanly with the standard remedy", async () => {
    tc = await createTestContext();
    await writeRemote(tc.root, "broken", { url: "http://localhost:1", environment: "x" });
    const result = await remoteRunHandler(tc.ctx, { remote: "broken", runId: "run-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach remote/i);
  });

  // D2b's own run-read gating (server.ts) -- a 401 here means the remote
  // has AART_DEPLOY_TOKEN configured but this remote's own tokenRef isn't
  // (or resolves wrong); a dedicated remedy, not a generic HTTP-401 string.
  it("a 401 from a token-gated remote (no tokenRef configured locally for it) gets the run-read-specific remedy naming --token-ref", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer("a-real-token");
    await writeRemote(tc.root, "gated", { url: live.url, environment: "staging" }); // no tokenRef

    const result = await remoteRunHandler(tc.ctx, { remote: "gated", runId: "run-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token/i);
    expect(result.error).toMatch(/--token-ref/);
  });
});
