// remoteApproveHandler (aart_remote_approve) — Wave 2C (AMENDMENTS.md A65).
// Every real-write test stands up a REAL @aart/server `startServer` instance
// as the "remote" (not a hand-rolled fake mimicking POST /approvals/:id/
// decision's response shape) — the same discipline
// remote-observability.test.ts already established for D2b's four READ
// tools, chosen here for the identical reason: this handler's own success
// path depends on decideApprovalTask's real branching (sentinel decode,
// gate validation, computeApprovalState, EngineBoundary.resumeDirect) and a
// hand-mocked response would risk silently drifting from what that route
// actually does.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeEngine, startServer, systemClock, type ServerHandle } from "@aart/server";
import { createFsStore, type AartStore } from "@aart/store";
import type { ApprovalTask, RunRecord, Workflow } from "@aart/types";
import type { TestContext } from "../test-utils.js";
import { createTestContext } from "../test-utils.js";
import { remoteApproveHandler } from "./remote-governance.js";

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

/** Mirrors remote-observability.test.ts's own startRemoteServer exactly (real fs-backed store, createFakeEngine, no ticker) — see this file's own module doc comment for why a real server, not a hand-mock. `deployToken`, when given, makes the remote's mutation routes (including POST /approvals/:id/decision) require a matching Bearer token (requireDeployTokenIfConfigured, http/server.ts). */
async function startRemoteServer(deployToken?: string): Promise<{ store: AartStore; url: string; handle: ServerHandle; root: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), "aart-remote-gov-test-"));
  const store = createFsStore(root);
  const engine = createFakeEngine(store, systemClock);
  const handle = await startServer({ store, engine, clock: systemClock, port: 0, runTicker: false, deployToken });
  remote = { store, url: `http://127.0.0.1:${handle.port}`, handle, root };
  return remote;
}

/** Mirrors remote-observability.test.ts's own writeRemote helper (merges into any existing remotes.json rather than overwriting it). */
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

/** Mirrors remote-observability.test.ts's own makeWorkflow (the same minimal-valid-Workflow shape reproduced across this codebase's test suites — no shared cross-package test-fixture module exists to import from instead). */
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

/** A minimal "waiting" RunRecord — mirrors server.test.ts's own run_approve_1 fixture (POST /approvals/:id/decision's genuine per-run-wait test), just enough for createFakeEngine's resumeDirect to find and flip it, no real workflow execution involved. */
function makeWaitingRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    runId: overrides.runId ?? uniq("run"),
    workflowId: "wf",
    workflowVersion: "1",
    status: "waiting",
    approved: true,
    approvalMode: "governed",
    trigger: { type: "manual", id: "t1", source: "test", payload: {}, receivedAt: now },
    inputs: {},
    trace: [],
    waits: [],
    artifacts: [],
    snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: now },
    startedAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("remoteApproveHandler (aart_remote_approve) — configuration failures", () => {
  it("fails cleanly with a remedy naming 'aart remote add' when the named remote isn't configured", async () => {
    tc = await createTestContext();
    const result = await remoteApproveHandler(tc.ctx, { remote: "no-such-remote", taskId: "task-1", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("fails cleanly with a remedy when the remote host is unreachable", async () => {
    tc = await createTestContext();
    await writeRemote(tc.root, "staging", { url: "http://localhost:1", environment: "staging-env" });
    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-1", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach remote/i);
  });

  it("unknown taskId on a real remote surfaces the remote's own precise message, not a wrong hardcoded guess", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });
    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "no-such-task", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/approval task not found/i);
  });
});

describe("remoteApproveHandler — the genuine per-run human.approval wait shape (kind: run_step)", () => {
  it("approves a paused run on the remote -- the run itself actually resumes (waiting -> running), verified directly on the remote's own store", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const runId = uniq("run-wait");
    await live.store.runs.put(makeWaitingRun({ runId }));
    await live.store.approvals.put({ id: "task-run", runId, stepId: "approve_step", title: "Approve me", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-run", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("run_step");
    expect(result.runId).toBe(runId);
    expect(result.stepId).toBe("approve_step");
    expect(result.status).toBe("approved");
    expect(result.reviewer).toBe("alice");

    // The load-bearing proof: the REMOTE's own persisted state actually
    // changed, not just this handler's own return value -- mirrors
    // server.test.ts's own "POST /approvals/:id/decision ... run resumes"
    // proof (fx.store.runs.get(...).status === "running").
    await expect(live.store.runs.get(runId)).resolves.toMatchObject({ status: "running" });
    await expect(live.store.approvals.get("task-run")).resolves.toMatchObject({ status: "approved", reviewer: "alice" });
  });

  it("rejects a paused run on the remote -- the ApprovalTask records 'rejected', reviewer stays free-text", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const runId = uniq("run-wait-reject");
    await live.store.runs.put(makeWaitingRun({ runId }));
    await live.store.approvals.put({ id: "task-run-reject", runId, stepId: "approve_step", title: "t", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-run-reject", decision: "rejected", reviewer: "bob the reviewer" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("rejected");
    expect(result.reviewer).toBe("bob the reviewer");
    await expect(live.store.approvals.get("task-run-reject")).resolves.toMatchObject({ status: "rejected", reviewer: "bob the reviewer" });
  });
});

describe("remoteApproveHandler — the workflow-version gate shape (kind: workflow_version)", () => {
  it("approves a pending humanReview gate on the remote -- gates.humanReview flips to passed, approval recomputed, verified via a real GET /approvals on the remote", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const workflowId = uniq("wf-gate");
    await live.store.workflows.put(
      makeWorkflow({ id: workflowId, gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "waived", humanReview: "pending" } }),
    );
    // The SAME sentinel encoding POST /approvals/:id/decision itself decodes
    // (governance's real workflowVersionApprovalSubject) -- using
    // tc.ctx.governance here (not a hand-rolled runId/stepId string) so this
    // test can't silently drift from the real encoding.
    const { runId, stepId } = tc.ctx.governance.workflowVersionApprovalSubject(workflowId, "1.0.0", "humanReview");
    await live.store.approvals.put({ id: "task-gate", runId, stepId, title: "Review", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-gate", decision: "approved", reviewer: "carol" });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("workflow_version");
    expect(result.workflowId).toBe(workflowId);
    expect(result.workflowVersion).toBe("1.0.0");
    expect((result.gates as { humanReview: string }).humanReview).toBe("passed");
    // Every OTHER required gate was already passed/waived above, so this
    // ONE decision is the last domino -- approval flips to "approved" as a
    // documented side effect of decideApprovalTask's own unconditional
    // recompute (AMENDMENTS.md A61's own "missed composition root" note).
    expect(result.approval).toBe("approved");

    // Verify via the remote's own real GET /approvals (not just this
    // handler's own return value, and not just direct store access) --
    // the STANDING IMPERATIVE's own explicit verification instruction.
    const approvalsResponse = await fetch(`${live.url}/approvals`);
    expect(approvalsResponse.status).toBe(200);
    const approvalsBody = (await approvalsResponse.json()) as { tasks: ApprovalTask[] };
    const decided = approvalsBody.tasks.find((t) => t.id === "task-gate");
    expect(decided?.status).toBe("approved");
    expect(decided?.reviewer).toBe("carol");

    const persistedWorkflow = await live.store.workflows.get(workflowId, "1.0.0");
    expect(persistedWorkflow?.gates.humanReview).toBe("passed");
    expect(persistedWorkflow?.approval).toBe("approved");
  });

  it("a riskReview decision writes gates.riskReview, not gates.humanReview -- the ACTUAL decoded gate, never hardcoded", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const workflowId = uniq("wf-risk");
    await live.store.workflows.put(makeWorkflow({ id: workflowId }));
    const { runId, stepId } = tc.ctx.governance.workflowVersionApprovalSubject(workflowId, "1.0.0", "riskReview");
    await live.store.approvals.put({ id: "task-risk", runId, stepId, title: "Risk review", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-risk", decision: "rejected", reviewer: "dave" });
    expect(result.ok).toBe(true);
    const gates = result.gates as { riskReview: string; humanReview: string };
    expect(gates.riskReview).toBe("failed");
    expect(gates.humanReview).toBe("pending"); // untouched
  });

  it("needs_changes maps to a pending gate, not passed/failed", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const workflowId = uniq("wf-needs-changes");
    await live.store.workflows.put(makeWorkflow({ id: workflowId }));
    const { runId, stepId } = tc.ctx.governance.workflowVersionApprovalSubject(workflowId, "1.0.0", "humanReview");
    await live.store.approvals.put({ id: "task-needs-changes", runId, stepId, title: "t", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-needs-changes", decision: "needs_changes", reviewer: "erin" });
    expect(result.ok).toBe(true);
    expect((result.gates as { humanReview: string }).humanReview).toBe("pending");
    expect(result.status).toBe("needs_changes");
  });

  it("task.decision (arbitrary free-form payload) is never echoed back in the result -- explicit allowlist, not a spread", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer();
    const workflowId = uniq("wf-allowlist");
    await live.store.workflows.put(makeWorkflow({ id: workflowId }));
    const { runId, stepId } = tc.ctx.governance.workflowVersionApprovalSubject(workflowId, "1.0.0", "humanReview");
    await live.store.approvals.put({ id: "task-allowlist", runId, stepId, title: "t", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId: "task-allowlist", decision: "approved", reviewer: "frank" });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("decision");
    expect(JSON.stringify(result)).not.toContain('"decision"');
  });
});

// D2a security hardening (AMENDMENTS.md A59/A60) — token gating and
// server-derived attribution. Mirrors http/server.test.ts's own "POST
// /approvals/:id/decision — token-derived attribution" describe block, now
// proven through this handler's own real HTTP call rather than a raw fetch.
describe("remoteApproveHandler — deploy-token gating and server-derived authenticatedAs", () => {
  async function seedGateTask(store: AartStore, ctx: TestContext["ctx"], workflowId: string): Promise<string> {
    await store.workflows.put(makeWorkflow({ id: workflowId }));
    const { runId, stepId } = ctx.governance.workflowVersionApprovalSubject(workflowId, "1.0.0", "humanReview");
    const taskId = uniq("task");
    await store.approvals.put({ id: taskId, runId, stepId, title: "t", description: "d", status: "pending", createdAt: "2026-07-13T00:00:00.000Z" });
    return taskId;
  }

  it("wrong token -> 401 with a remedy naming how to configure the token for this remote", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer("correct-token");
    const workflowId = uniq("wf-wrong-token");
    const taskId = await seedGateTask(live.store, tc.ctx, workflowId);
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env", tokenRef: "secrets.DEPLOY_TOKEN" });
    await fs.writeFile(join(tc.root, "secrets.json"), JSON.stringify({ DEPLOY_TOKEN: "the-wrong-token" }), "utf8");

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/aart remote add.*--token-ref/is);

    // The refused write must not have happened.
    await expect(live.store.approvals.get(taskId)).resolves.toMatchObject({ status: "pending" });
  });

  it("missing token (no tokenRef configured for this remote at all) -> 401 with the same remedy", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer("correct-token");
    const workflowId = uniq("wf-missing-token");
    const taskId = await seedGateTask(live.store, tc.ctx, workflowId);
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" }); // no tokenRef

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/deploy token/i);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("correct token succeeds against a token-gated remote and surfaces the SERVER-derived authenticatedAs: 'deploy-token' -- this handler's own input has no such field to set", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer("correct-token");
    const workflowId = uniq("wf-correct-token");
    const taskId = await seedGateTask(live.store, tc.ctx, workflowId);
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env", tokenRef: "secrets.DEPLOY_TOKEN" });
    await fs.writeFile(join(tc.root, "secrets.json"), JSON.stringify({ DEPLOY_TOKEN: "correct-token" }), "utf8");

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.authenticatedAs).toBe("deploy-token");
    await expect(live.store.approvals.get(taskId)).resolves.toMatchObject({ status: "approved", authenticatedAs: "deploy-token" });
  });

  it("a tokenless-local remote (no deployToken configured there at all) leaves authenticatedAs undefined -- never a false 'definitely anonymous' signal", async () => {
    tc = await createTestContext();
    const live = await startRemoteServer(); // no deployToken configured on the remote
    const workflowId = uniq("wf-tokenless");
    const taskId = await seedGateTask(live.store, tc.ctx, workflowId);
    await writeRemote(tc.root, "staging", { url: live.url, environment: "staging-env" });

    const result = await remoteApproveHandler(tc.ctx, { remote: "staging", taskId, decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(true);
    expect(result.authenticatedAs).toBeUndefined();
  });
});
