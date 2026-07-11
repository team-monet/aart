// End-to-end HTTP API tests — architecture §0.1-0.3/§6: webhook ingress
// (incl. real mandatory HMAC), approval endpoints, the flag-clear write
// path, resume/signal endpoints, github PR-merge ingestion, and the read
// API surface for S8's dashboard.
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@aart/types";
import { computeHmacSignature } from "../triggers/hmac.js";
import { createTestFixture, type TestFixture } from "../test-helpers.js";
import { startServer, type ServerHandle } from "./server.js";

function fixtureWorkflow(version: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf_detail",
    name: "n",
    version,
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [] },
    approval: "draft",
    gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    ...overrides,
  };
}

let fx: TestFixture | undefined;
let handle: ServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await fx?.cleanup();
  fx = undefined;
});

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("GET /health", () => {
  it("returns ok", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/health`);
    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toEqual({ status: "ok" });
  });
});

describe("webhook ingress (architecture §6.1/§15)", () => {
  it("valid HMAC: 200, starts a run", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "binding_1",
      workflowId: "wf_webhook",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_1", webhookHmacSecretRef: "secrets.WEBHOOK_SECRET" },
      createdAt: fx.clock.nowIso(),
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, secretResolver: async () => "real-secret" });

    const payload = { file_url: "https://x/bill.pdf" };
    const rawBody = JSON.stringify(payload);
    const sig = computeHmacSignature(new TextEncoder().encode(rawBody), "real-secret");
    const res = await fetch(`http://localhost:${handle.port}/webhooks/binding_1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": sig },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string };
    expect(body.kind).toBe("started");
  });

  it("invalid HMAC: 401, and a rejected-trigger record is persisted (queryable after the fact)", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "binding_2",
      workflowId: "wf_webhook",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_2", webhookHmacSecretRef: "secrets.WEBHOOK_SECRET" },
      createdAt: fx.clock.nowIso(),
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, secretResolver: async () => "real-secret" });

    const res = await fetch(`http://localhost:${handle.port}/webhooks/binding_2`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(401);
    const rejected = await fx.store.rejectedTriggers.list({ reason: "bad_hmac" });
    expect(rejected.length).toBe(1);
  });

  it("unknown binding id: 404", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/webhooks/no-such-binding`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("--environment scoping (AMENDMENTS.md A45) — config.environmentId restricts which deployments' trigger bindings activate", () => {
  it("two envs, two deployments, scoped server activates exactly one", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "binding_env_a",
      workflowId: "wf_scoped",
      workflowVersion: "1",
      environmentId: "env_a",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_env_a" },
      createdAt: fx.clock.nowIso(),
    });
    await fx.store.deployments.put({
      id: "binding_env_b",
      workflowId: "wf_scoped",
      workflowVersion: "1",
      environmentId: "env_b",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_env_b" },
      createdAt: fx.clock.nowIso(),
    });
    // No secretResolver — these bindings have no webhookHmacSecretRef, so
    // HMAC verification is skipped (secret ?? "" against no signature
    // header both resolve falsy the same way the unscoped tests above do);
    // this test isolates environment scoping specifically, not HMAC.
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, environmentId: "env_a" });

    const resA = await fetch(`http://localhost:${handle.port}/webhooks/binding_env_a`, { method: "POST", body: "{}" });
    expect(resA.status, "env_a's own binding is active").not.toBe(404);

    const resB = await fetch(`http://localhost:${handle.port}/webhooks/binding_env_b`, { method: "POST", body: "{}" });
    expect(resB.status, "env_b's binding is invisible to a server scoped to env_a").toBe(404);
  });

  it("unset environmentId activates every deployment across every environment (documented dev-convenience default)", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "binding_all_a",
      workflowId: "wf_scoped",
      workflowVersion: "1",
      environmentId: "env_a",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_all_a" },
      createdAt: fx.clock.nowIso(),
    });
    await fx.store.deployments.put({
      id: "binding_all_b",
      workflowId: "wf_scoped",
      workflowVersion: "1",
      environmentId: "env_b",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_all_b" },
      createdAt: fx.clock.nowIso(),
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    for (const bindingId of ["binding_all_a", "binding_all_b"]) {
      const res = await fetch(`http://localhost:${handle.port}/webhooks/${bindingId}`, { method: "POST", body: "{}" });
      expect(res.status, `${bindingId} active with no --environment scoping`).not.toBe(404);
    }
  });
});

describe("github webhook ingress + PR-merge-as-approval (architecture §7.2/§6.1)", () => {
  it("a non-merge github event runs through normal trigger intake", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "gh_binding_1",
      workflowId: "wf_gh",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "github", webhookHmacSecretRef: "secrets.GH_SECRET" },
      createdAt: fx.clock.nowIso(),
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, secretResolver: async () => "gh-secret" });
    const payload = { action: "opened", pull_request: { number: 7 } };
    const rawBody = JSON.stringify(payload);
    const sig = computeHmacSignature(new TextEncoder().encode(rawBody), "gh-secret");
    const res = await fetch(`http://localhost:${handle.port}/webhooks/github/gh_binding_1`, {
      method: "POST",
      headers: { "x-hub-signature-256": sig, "x-github-delivery": "d1" },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string };
    expect(body.kind).toBe("started");
  });

  it("a PR-merge event writes the ApprovalTask decision through resolveGithubApprovalTarget, not a new run", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "gh_binding_2",
      workflowId: "wf_gh",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "github", webhookHmacSecretRef: "secrets.GH_SECRET" },
      createdAt: fx.clock.nowIso(),
    });
    await fx.store.approvals.put({ id: "at_pr", runId: "run_release", stepId: "approve_release", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    handle = await startServer({
      store: fx.store,
      engine: fx.engine,
      clock: fx.clock,
      port: 0,
      runTicker: false,
      secretResolver: async () => "gh-secret",
      resolveGithubApprovalTarget: () => ({ runId: "run_release", stepId: "approve_release" }),
    });
    const payload = { action: "closed", pull_request: { number: 8, merged: true, merged_by: { login: "octocat" } } };
    const rawBody = JSON.stringify(payload);
    const sig = computeHmacSignature(new TextEncoder().encode(rawBody), "gh-secret");
    const res = await fetch(`http://localhost:${handle.port}/webhooks/github/gh_binding_2`, {
      method: "POST",
      headers: { "x-hub-signature-256": sig },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string };
    expect(body.kind).toBe("pr_merge_approval");
    const task = await fx.store.approvals.get("at_pr");
    expect(task?.status).toBe("approved");
    expect(task?.reviewer).toBe("octocat");
  });
});

describe("approval decision endpoint (spec §17.5's CLI/dashboard authority surface)", () => {
  it("records the decision and triggers a resume for a terminal status", async () => {
    fx = await createTestFixture();
    await fx.store.waits.put("run_approve_1", "approve_step", { type: "approval", taskId: "at_1", schemaVersion: 1 }, fx.clock.nowIso());
    await fx.store.runs.put({
      runId: "run_approve_1",
      workflowId: "wf",
      workflowVersion: "1",
      status: "waiting",
      approved: true,
      approvalMode: "governed",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    await fx.store.approvals.put({ id: "at_1", runId: "run_approve_1", stepId: "approve_step", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/approvals/at_1/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "jane@example.com" }),
    });
    expect(res.status).toBe(200);
    const persisted = await fx.store.approvals.get("at_1");
    expect(persisted?.status).toBe("approved");
    expect(persisted?.reviewer).toBe("jane@example.com");
    await expect(fx.store.runs.get("run_approve_1")).resolves.toMatchObject({ status: "running" });
  });

  it("400s without a reviewer", async () => {
    fx = await createTestFixture();
    await fx.store.approvals.put({ id: "at_2", runId: "run_x", stepId: "s", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/approvals/at_2/decision`, { method: "POST", body: JSON.stringify({ status: "approved" }) });
    expect(res.status).toBe(400);
  });
});

describe("flagged-run clear endpoint (architecture §13.3 — dashboard/CLI only, not MCP)", () => {
  it("clears the flag, leaves status failed", async () => {
    fx = await createTestFixture();
    await fx.store.runs.put({
      runId: "run_flagged",
      workflowId: "wf",
      workflowVersion: "1",
      status: "failed",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
      flag: { kind: "poison", flaggedAt: fx.clock.nowIso() },
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/runs/run_flagged/flag/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearedBy: "ops@example.com" }),
    });
    expect(res.status).toBe(200);
    const persisted = await fx.store.runs.get("run_flagged");
    expect(persisted?.status).toBe("failed");
    expect(persisted?.flag?.clearedBy).toBe("ops@example.com");
  });

  it("409s when there's no flag to clear", async () => {
    fx = await createTestFixture();
    await fx.store.runs.put({
      runId: "run_unflagged",
      workflowId: "wf",
      workflowVersion: "1",
      status: "completed",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/runs/run_unflagged/flag/clear`, { method: "POST", body: JSON.stringify({ clearedBy: "ops" }) });
    expect(res.status).toBe(409);
  });
});

describe("read API surface (S8's dashboard consumes this)", () => {
  it("GET /runs and /runs/:id", async () => {
    fx = await createTestFixture();
    await fx.store.runs.put({
      runId: "run_read_1",
      workflowId: "wf_read",
      workflowVersion: "1",
      status: "completed",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const listRes = await fetch(`http://localhost:${handle.port}/runs?workflowId=wf_read`);
    const listBody = (await json(listRes)) as { runs: unknown[] };
    expect(listBody.runs).toHaveLength(1);

    const getRes = await fetch(`http://localhost:${handle.port}/runs/run_read_1`);
    expect(getRes.status).toBe(200);
    const getBody = (await json(getRes)) as { run: { runId: string } };
    expect(getBody.run.runId).toBe("run_read_1");

    const missingRes = await fetch(`http://localhost:${handle.port}/runs/no-such-run`);
    expect(missingRes.status).toBe(404);
  });

  it("GET /waiting-runs, /flagged-runs, /workflows, /environments, /deployments, /rejected-triggers", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    for (const path of ["/waiting-runs", "/flagged-runs", "/workflows", "/environments", "/deployments", "/rejected-triggers"]) {
      const res = await fetch(`http://localhost:${handle.port}${path}`);
      expect(res.status, `GET ${path}`).toBe(200);
    }
  });

  it("GET /workflows/:id -> {workflow, versions}: latest by default, a specific version via ?version=, 404 with {error} when unknown (root AMENDMENTS.md A43 — closes the SEAMS.md-flagged 'enrich GET /workflows' gap)", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("0.1.0"));
    await fx.store.workflows.put(fixtureWorkflow("0.2.0", { approval: "approved" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const latestRes = await fetch(`http://localhost:${handle.port}/workflows/wf_detail`);
    expect(latestRes.status).toBe(200);
    const latestBody = (await json(latestRes)) as { workflow: Workflow; versions: string[] };
    expect(latestBody.workflow.version).toBe("0.2.0");
    expect(latestBody.workflow.approval).toBe("approved");
    expect(latestBody.versions).toEqual(["0.1.0", "0.2.0"]);

    const specificRes = await fetch(`http://localhost:${handle.port}/workflows/wf_detail?version=0.1.0`);
    expect(specificRes.status).toBe(200);
    const specificBody = (await json(specificRes)) as { workflow: Workflow; versions: string[] };
    expect(specificBody.workflow.version).toBe("0.1.0");
    expect(specificBody.versions).toEqual(["0.1.0", "0.2.0"]); // version history is the same regardless of which version was requested

    const missingRes = await fetch(`http://localhost:${handle.port}/workflows/no-such-workflow`);
    expect(missingRes.status).toBe(404);
    expect(await json(missingRes)).toEqual({ error: "not found" });
  });

  it("GET /dashboard/* reserves the mount point (architecture §13, S8's content)", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/dashboard/runs`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { mount: string };
    expect(body.mount).toBe("dashboard");
  });
});

describe("resume/signal endpoints", () => {
  it("POST /runs/:runId/resume calls engine.resumeDirect", async () => {
    fx = await createTestFixture();
    await fx.store.waits.put("run_resume_1", "wait_step", { type: "manual", schemaVersion: 1 }, fx.clock.nowIso());
    await fx.store.runs.put({
      runId: "run_resume_1",
      workflowId: "wf",
      workflowVersion: "1",
      status: "waiting",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/runs/run_resume_1/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stepId: "wait_step", payload: { ok: true } }),
    });
    expect(res.status).toBe(200);
    await expect(fx.store.runs.get("run_resume_1")).resolves.toMatchObject({ status: "running" });
  });

  it("POST /runs/:runId/signal appends a Signal and attempts resumeWithSignal", async () => {
    fx = await createTestFixture();
    await fx.store.waits.put("run_signal_1", "wait_step", { type: "signal", name: "quote.received", correlationId: "corr-http-1", schemaVersion: 1 }, fx.clock.nowIso());
    await fx.store.runs.put({
      runId: "run_signal_1",
      workflowId: "wf",
      workflowVersion: "1",
      status: "waiting",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/runs/run_signal_1/signal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "quote.received", correlationId: "corr-http-1", payload: { price: 10 } }),
    });
    expect(res.status).toBe(200);
    await expect(fx.store.runs.get("run_signal_1")).resolves.toMatchObject({ status: "running" });
    await expect(fx.store.signals.list()).resolves.toHaveLength(1);
  });
});
