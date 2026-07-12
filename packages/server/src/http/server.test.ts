// End-to-end HTTP API tests — architecture §0.1-0.3/§6: webhook ingress
// (incl. real mandatory HMAC), approval endpoints, the flag-clear write
// path, resume/signal endpoints, github PR-merge ingestion, and the read
// API surface for S8's dashboard.
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@aart/types";
import { produceBundle, sanitizeFilename, type Bundle } from "../bundle/bundle.js";
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

/** D1 "remotes + push" (AMENDMENTS.md A56) — local mirror of `bundleToBundleLike`'s file-flattening (`@aart/cli`'s `real-server-port.ts`), same as `bundle/load.test.ts`'s own `bundleToFiles` — see that file's doc comment for why this package's own tests build this locally rather than importing across a package boundary. */
function bundleToFiles(bundle: Bundle): Record<string, string> {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(bundle.manifest, null, 2),
    "triggers.json": JSON.stringify(bundle.triggers, null, 2),
  };
  for (const [key, workflow] of Object.entries(bundle.definitions)) files[`definitions/${sanitizeFilename(key)}.json`] = JSON.stringify(workflow, null, 2);
  for (const [key, manifest] of Object.entries(bundle.packs)) files[`packs/${sanitizeFilename(key)}.json`] = JSON.stringify(manifest, null, 2);
  for (const [key, entry] of Object.entries(bundle.registry.prompts)) files[`registry/prompts/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  for (const [key, entry] of Object.entries(bundle.registry.schemas)) files[`registry/schemas/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  return files;
}

function deployableWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  const approvedGates = { validate: "passed" as const, readiness: "passed" as const, evals: "passed" as const, riskReview: "passed" as const, humanReview: "passed" as const };
  return { id, name: "n", version: "1", inputs: [], outputs: [], execution: { type: "workflow", steps: [] }, approval: "approved", gates: approvedGates, ...overrides };
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

// D2a security hardening, breaking-change bind default (AMENDMENTS.md A59)
// — a fast, direct unit-level proof (no CLI/store-root overhead) that
// startServer itself honors config.host and defaults to loopback-only when
// omitted. `ServerHandle`'s own PUBLIC type only exposes {server, port,
// ticker?, getRoutes, close} -- `.server` is the real `node:http` `Server`
// instance underneath (ServerHandle.server, this file's own interface), so
// `.address()` is reachable directly without any cast; used here (not just
// a fetch-succeeds check) because a fetch to `localhost` would succeed
// whether bound to 127.0.0.1 OR 0.0.0.0 -- only inspecting the actual bound
// address distinguishes them.
describe("HTTP bind address (D2a security hardening, AMENDMENTS.md A59)", () => {
  it("defaults to loopback-only (127.0.0.1) when config.host is omitted", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const address = handle.server.address();
    expect(address).toMatchObject({ address: "127.0.0.1" });
  });

  it("an explicit config.host is honored", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, host: "0.0.0.0" });
    const address = handle.server.address();
    expect(address).toMatchObject({ address: "0.0.0.0" });
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

  // D2a fix pass (AMENDMENTS.md A60, FIX 1) — before this fix, these three
  // routes passed no maxBodyBytes of their own, so they silently inherited
  // D2a's GLOBAL DEFAULT_MAX_BODY_BYTES (1MB, AMENDMENTS.md A59) the moment
  // that default started applying to every uncapped route — a real
  // regression for webhook deliveries specifically (external,
  // operator-uncontrolled payloads; GitHub's own ceiling is 25MB, and
  // GitHub does not retry a delivery it can't make). This proves the fix:
  // a body clearly over the OLD 1MB default, but under the new
  // MAX_WEBHOOK_INGEST_BYTES cap, now succeeds all the way through HMAC
  // verification and trigger intake instead of 413ing before either ever run.
  it("size cap: a body between 1MB and MAX_WEBHOOK_INGEST_BYTES succeeds through to HMAC verification and intake (previously 413'd under the global 1MB default)", async () => {
    fx = await createTestFixture();
    await fx.store.deployments.put({
      id: "binding_large",
      workflowId: "wf_webhook",
      workflowVersion: "1",
      environmentId: "env_1",
      triggerConfig: { type: "webhook", webhookPath: "/webhooks/binding_large", webhookHmacSecretRef: "secrets.WEBHOOK_SECRET" },
      createdAt: fx.clock.nowIso(),
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, secretResolver: async () => "real-secret" });

    // ~2MB — comfortably over the pre-fix 1MB global default, comfortably
    // under the new 25 MiB webhook cap.
    const payload = { file_url: "https://x/bill.pdf", padding: "a".repeat(2 * 1024 * 1024) };
    const rawBody = JSON.stringify(payload);
    expect(rawBody.length).toBeGreaterThan(1_048_576);
    const sig = computeHmacSignature(new TextEncoder().encode(rawBody), "real-secret");
    const res = await fetch(`http://localhost:${handle.port}/webhooks/binding_large`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aart-signature": sig },
      body: rawBody,
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string };
    expect(body.kind).toBe("started");
  });

  it("size cap: a body over MAX_WEBHOOK_INGEST_BYTES is rejected 413", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    // A plain oversized body — 413 fires from the router's Content-Length
    // pre-check before this handler (or HMAC verification) ever runs, so
    // the content doesn't need to be a real signed payload or a real
    // binding id (mirrors /bundles/ingest's own size-cap test below).
    const oversized = "x".repeat(27 * 1024 * 1024); // 27MB > the 25 MiB (26,214,400-byte) cap
    const res = await fetch(`http://localhost:${handle.port}/webhooks/no-such-binding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });
    expect(res.status).toBe(413);
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

  // AMENDMENTS.md A46/A47: this endpoint now ALSO handles workflow-version-
  // level decisions (aart request-approval's sentinel), decoding the
  // ACTUAL gate a task's stepId encodes rather than assuming humanReview —
  // the exact bug a former dashboard-local reimplementation of this logic
  // had (root AMENDMENTS.md A46's flagged finding). Exercised through the
  // real HTTP endpoint, both gates, not just the underlying function.
  it("a workflow-version riskReview decision writes gates.riskReview, not gates.humanReview, over HTTP", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_risk" }));
    const subject = { runId: "workflow-version:wf_risk@1.0.0", stepId: "__gate:riskReview__" };
    await fx.store.approvals.put({ id: "at_risk", ...subject, title: "Risk review", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/approvals/at_risk/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "jane@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; gates: { riskReview: string; humanReview: string } };
    expect(body.kind).toBe("workflow_version");
    expect(body.gates.riskReview).toBe("passed");
    expect(body.gates.humanReview).toBe("pending");

    const persisted = await fx.store.workflows.get("wf_risk", "1.0.0");
    expect(persisted?.gates.riskReview).toBe("passed");
    expect(persisted?.gates.humanReview).toBe("pending");
  });

  it("a hand-crafted task targeting gate 'validate' is refused with 400, not silently written", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_bad_gate" }));
    await fx.store.approvals.put({ id: "at_bad", runId: "workflow-version:wf_bad_gate@1.0.0", stepId: "__gate:validate__", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/approvals/at_bad/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "jane@example.com" }),
    });
    expect(res.status).toBe(400);
    const persisted = await fx.store.workflows.get("wf_bad_gate", "1.0.0");
    expect(persisted?.gates.validate).toBe("passed"); // untouched, not overwritten
  });

  it("404s for an unknown taskId", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/approvals/no-such-task/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "jane" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("dashboard write actions (AMENDMENTS.md A47) — every dashboard write now has a real server-side implementation", () => {
  it("POST /runs/trigger starts a real run via EngineBoundary.startRun and returns it", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_trigger" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/runs/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId: "wf_trigger", inputs: { x: 1 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; run: { runId: string; status: string; workflowId: string } };
    expect(body.kind).toBe("started");
    expect(body.run.workflowId).toBe("wf_trigger");
    expect(body.run.status).toBe("pending");
    await expect(fx.store.runs.get(body.run.runId)).resolves.toMatchObject({ status: "pending" });
    await expect(fx.store.jobQueue.get(body.run.runId)).resolves.toBeDefined(); // enqueued for real, not just persisted
  });

  it("POST /runs/trigger 400s without a workflowId", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/runs/trigger`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inputs: {} }) });
    expect(res.status).toBe(400);
  });

  it("POST /workflows/:id/approve recomputes approval from the real computeApprovalState", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_approve", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/workflows/wf_approve/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0", action: "approve", trustMode: "governed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflow: { approval: string } };
    expect(body.workflow.approval).toBe("approved");
  });

  it("POST /workflows/:id/promote uses the real promoteWorkflowVersionToEnvironment (creates a Deployment)", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_promote", approval: "approved" }));
    await fx.store.environments.put({ id: "env_promote", name: "staging", config: { trustMode: "dev" } });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const res = await fetch(`http://localhost:${handle.port}/workflows/wf_promote/promote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0", environmentId: "env_promote" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("promoted");
    await expect(fx.store.deployments.list({ workflowId: "wf_promote" })).resolves.toHaveLength(1);
  });

  it("POST /workflows/:id/block-promotion, /unblock-promotion, /mark-needs-review, /clear-needs-review round-trip the corresponding boolean flag", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_flags" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const base = `http://localhost:${handle.port}/workflows/wf_flags`;
    const post = (path: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "1.0.0" }) });

    await post("/block-promotion");
    await expect(fx.store.workflows.get("wf_flags", "1.0.0")).resolves.toMatchObject({ promotionBlocked: true });
    await post("/unblock-promotion");
    await expect(fx.store.workflows.get("wf_flags", "1.0.0")).resolves.toMatchObject({ promotionBlocked: false });
    await post("/mark-needs-review");
    await expect(fx.store.workflows.get("wf_flags", "1.0.0")).resolves.toMatchObject({ needsReview: true });
    await post("/clear-needs-review");
    await expect(fx.store.workflows.get("wf_flags", "1.0.0")).resolves.toMatchObject({ needsReview: false });

    const missing = await fetch(`${base}/block-promotion`.replace("wf_flags", "no-such-wf"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: "1.0.0" }) });
    expect(missing.status).toBe(404);
  });

  it("POST /workflows/:id/trigger-improvement returns a real ImprovementBrief (@aart/evidence's generateImprovementBrief)", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_improve" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/workflows/wf_improve/trigger-improvement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflowId: string; workflowVersion: string };
    expect(body.workflowId).toBe("wf_improve");
    expect(body.workflowVersion).toBe("1.0.0");
  });

  it("POST /corrections records a Correction; the 3 outcome routes act on it via URL-encoded correctionKey", async () => {
    fx = await createTestFixture();
    await fx.store.runs.put({
      runId: "run_corr",
      workflowId: "wf_corr",
      workflowVersion: "1.0.0",
      status: "completed",
      approved: true,
      approvalMode: "dev",
      trigger: { type: "manual", id: "t1", source: "cli", payload: null, receivedAt: fx.clock.nowIso() },
      inputs: {},
      trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { total: 1 }, startedAt: fx.clock.nowIso() }],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: fx.clock.nowIso() },
      startedAt: fx.clock.nowIso(),
      updatedAt: fx.clock.nowIso(),
      schemaVersion: 1,
    });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const base = `http://localhost:${handle.port}`;

    const recordRes = await fetch(`${base}/corrections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_corr", stepId: "step1", fieldPath: "outputs.total", observed: 1, corrected: 42, reason: "off by one", reviewer: "alice" }),
    });
    expect(recordRes.status).toBe(200);
    const key = encodeURIComponent("run_corr:step1:outputs.total");

    const updateRes = await fetch(`${base}/corrections/${key}/update-run-output`, { method: "POST" });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as { run: { trace: Array<{ outputs?: Record<string, unknown> }> } };
    expect(updateBody.run.trace[0]?.outputs).toEqual({ total: 42 });

    const exampleRes = await fetch(`${base}/corrections/${key}/create-eval-example`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suiteId: "suite_1" }) });
    expect(exampleRes.status).toBe(200);
    await expect(fx.store.evals.listExamples("suite_1")).resolves.toHaveLength(1);

    const issueRes = await fetch(`${base}/corrections/${key}/create-issue`, { method: "POST" });
    expect(issueRes.status).toBe(200);
    const issueBody = (await issueRes.json()) as { workflowId: string };
    expect(issueBody.workflowId).toBe("wf_corr");

    const missingKey = encodeURIComponent("no-such-run:step1:outputs.total");
    const missingRes = await fetch(`${base}/corrections/${missingKey}/update-run-output`, { method: "POST" });
    expect(missingRes.status).toBe(404);
  });

  it("POST /evals/suites creates a suite; POST /evals/runs scores it with @aart/evidence's real scorer registry and persists the EvalRun", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_eval" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const base = `http://localhost:${handle.port}`;

    const createRes = await fetch(`${base}/evals/suites`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My Suite", scorer: { id: "s1", kind: "exact_match" } }),
    });
    expect(createRes.status).toBe(200);
    const { suite } = (await createRes.json()) as { suite: { id: string } };
    await fx.store.evals.putExample({ id: "ex1", suiteId: suite.id, input: 5, expected: 5 });

    const runRes = await fetch(`${base}/evals/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suiteId: suite.id, workflowId: "wf_eval", workflowVersion: "1.0.0" }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as { evalRun: { passed: number; total: number } };
    expect(runBody.evalRun.passed).toBe(1);
    expect(runBody.evalRun.total).toBe(1);
    await expect(fx.store.evals.listRuns({ suiteId: suite.id })).resolves.toHaveLength(1);

    const missingSuiteRes = await fetch(`${base}/evals/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ suiteId: "no-such-suite", workflowId: "wf_eval" }) });
    expect(missingSuiteRes.status).toBe(404);
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

  // AMENDMENTS.md A47: the three dashboard list pages that used to read
  // `store.approvals`/`store.corrections`/`store.evals` directly (the same
  // store-divergence bug class root AMENDMENTS.md A43 fixed for workflow/
  // block detail) — SEAMS.md never published a route for these three,
  // "flagged" rather than built, until now.
  it("GET /approvals (optionally ?status=) lists ApprovalTasks", async () => {
    fx = await createTestFixture();
    await fx.store.approvals.put({ id: "at_r1", runId: "run_1", stepId: "s", title: "t", description: "d", status: "pending", createdAt: fx.clock.nowIso() });
    await fx.store.approvals.put({ id: "at_r2", runId: "run_2", stepId: "s", title: "t", description: "d", status: "approved", reviewer: "alice", decidedAt: fx.clock.nowIso(), createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const all = (await json(await fetch(`http://localhost:${handle.port}/approvals`))) as { tasks: unknown[] };
    expect(all.tasks).toHaveLength(2);

    const pendingOnly = (await json(await fetch(`http://localhost:${handle.port}/approvals?status=pending`))) as { tasks: Array<{ id: string }> };
    expect(pendingOnly.tasks.map((t) => t.id)).toEqual(["at_r1"]);
  });

  it("GET /corrections (optionally ?runId=&stepId=) lists Corrections", async () => {
    fx = await createTestFixture();
    await fx.store.corrections.put({ runId: "run_a", stepId: "s1", fieldPath: "outputs.x", observed: 1, corrected: 2, reason: "r", reviewer: "alice", createdAt: fx.clock.nowIso() });
    await fx.store.corrections.put({ runId: "run_b", stepId: "s1", fieldPath: "outputs.y", observed: 1, corrected: 2, reason: "r", reviewer: "bob", createdAt: fx.clock.nowIso() });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const all = (await json(await fetch(`http://localhost:${handle.port}/corrections`))) as { corrections: unknown[] };
    expect(all.corrections).toHaveLength(2);

    const filtered = (await json(await fetch(`http://localhost:${handle.port}/corrections?runId=run_a&stepId=s1`))) as { corrections: Array<{ runId: string }> };
    expect(filtered.corrections.map((c) => c.runId)).toEqual(["run_a"]);
  });

  it("GET /evals lists both suites and runs", async () => {
    fx = await createTestFixture();
    await fx.store.evals.putSuite({ id: "suite_1", name: "S", examples: [], scorer: { id: "s1", kind: "exact_match" }, tags: [] });
    await fx.store.evals.putRun({ id: "evalrun_1", suiteId: "suite_1", workflowId: "wf", workflowVersion: "1.0.0", status: "completed", total: 1, passed: 1, failed: 0, score: 1, regressions: [], improvements: [], reportArtifact: "a" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });

    const body = (await json(await fetch(`http://localhost:${handle.port}/evals`))) as { suites: unknown[]; runs: unknown[] };
    expect(body.suites).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
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

// D1 "remotes + push" (AMENDMENTS.md A56) — the deploy surface: POST
// /bundles/ingest, POST /bundles/plan, POST /environments. All three are
// gated by requireDeployToken; the three /webhooks/* routes above are NOT
// (a separate, per-binding HMAC mechanism, proven untouched by this suite
// still passing unchanged above).
describe("deploy surface — token gate (AMENDMENTS.md A56)", () => {
  it("POST /bundles/ingest: no AART_DEPLOY_TOKEN configured -> 401 with a remedy naming AART_DEPLOY_TOKEN, no store write", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_no_token"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_no_token", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // no deployToken
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer whatever" },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(401);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/AART_DEPLOY_TOKEN/);
    await expect(fx.store.deployments.list({ workflowId: "wf_no_token" })).resolves.toHaveLength(0);
  });

  it("POST /bundles/ingest: wrong token -> 401", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_wrong_token"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_wrong_token", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "real-token" });
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /bundles/ingest: missing Authorization header entirely -> 401", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_no_header"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_no_header", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "real-token" });
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /bundles/plan: also token-gated, same as ingest", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_plan_no_token"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_no_token", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /environments: no token -> 401, environment not created", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "production", trustMode: "production" }),
    });
    expect(res.status).toBe(401);
    await expect(fx.store.environments.getByName("production")).resolves.toBeUndefined();
  });

  it("GET routes stay completely open — no token required, unaffected by deployToken being configured", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "real-token" });
    const res = await fetch(`http://localhost:${handle.port}/environments`); // GET, no Authorization header at all
    expect(res.status).toBe(200);
  });
});

// D1 fix pass (AMENDMENTS.md A57, trust-boundary ruling) — promote is
// CONDITIONALLY gated (requireDeployTokenIfConfigured), unlike the three
// FAIL-CLOSED routes above: unconfigured -> stays open (pre-A56 behavior,
// tokenless local/dev dashboards keep working); configured -> requires the
// same valid Bearer the other three routes do.
describe("POST /workflows/:id/promote — conditional deploy-token gating (AMENDMENTS.md A57 fix pass)", () => {
  async function promoteSetup(fixture: TestFixture) {
    await fixture.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_promote_gate", approval: "approved" }));
    await fixture.store.environments.put({ id: "env_promote_gate", name: "gate-staging", config: { trustMode: "dev" } });
  }
  function promoteRequest(port: number, headers: Record<string, string>) {
    return fetch(`http://localhost:${port}/workflows/wf_promote_gate/promote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ version: "1.0.0", environmentId: "env_promote_gate" }),
    });
  }

  it("deployToken configured + correct Bearer -> 200, Deployment created", async () => {
    fx = await createTestFixture();
    await promoteSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "promote-gate-token" });
    const res = await promoteRequest(handle.port, { authorization: "Bearer promote-gate-token" });
    expect(res.status).toBe(200);
    await expect(fx.store.deployments.list({ workflowId: "wf_promote_gate" })).resolves.toHaveLength(1);
  });

  it("deployToken configured + wrong Bearer -> 401 with a remedy, no Deployment created", async () => {
    fx = await createTestFixture();
    await promoteSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "promote-gate-token" });
    const res = await promoteRequest(handle.port, { authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/Provide a valid "Authorization: Bearer <token>" header/);
    await expect(fx.store.deployments.list({ workflowId: "wf_promote_gate" })).resolves.toHaveLength(0);
  });

  it("deployToken configured + no Authorization header at all -> 401, no Deployment created", async () => {
    fx = await createTestFixture();
    await promoteSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "promote-gate-token" });
    const res = await promoteRequest(handle.port, {});
    expect(res.status).toBe(401);
    await expect(fx.store.deployments.list({ workflowId: "wf_promote_gate" })).resolves.toHaveLength(0);
  });

  it("deployToken UNCONFIGURED -> 200 with no Authorization header at all (unchanged pre-A56 behavior, never fail-closed)", async () => {
    fx = await createTestFixture();
    await promoteSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // no deployToken
    const res = await promoteRequest(handle.port, {});
    expect(res.status).toBe(200);
    await expect(fx.store.deployments.list({ workflowId: "wf_promote_gate" })).resolves.toHaveLength(1);
  });
});

// D2a fix pass (AMENDMENTS.md A60, FIX 2) — requireDeployToken (the
// fail-closed tier: /bundles/ingest, /bundles/plan, /environments) called
// checkAnyDeployToken([config.deployToken, config.deployTokenNext], provided)
// with NO guard that config.deployToken was actually set, unlike its
// conditional sibling requireDeployTokenIfConfigured (which already guards
// `if (!config.deployToken) return true`). A server configured with ONLY
// AART_DEPLOY_TOKEN_NEXT (no primary) would therefore ACCEPT a caller who
// supplied exactly that NEXT token on a fail-closed route — contradicting
// both the 401 remedy (which claims "no AART_DEPLOY_TOKEN configured") and
// this file's/config.ts's own doc comments on deployTokenNext ("cannot
// substitute for the primary token being configured at all"). Closed with
// an explicit `if (!config.deployToken)` guard in requireDeployToken,
// mirroring requireDeployTokenIfConfigured's own.
describe("deploy token rotation — deployTokenNext without a primary (D2a fix pass, AMENDMENTS.md A60, FIX 2)", () => {
  it("fail-closed tier (/bundles/ingest): a request bearing exactly the configured deployTokenNext value is STILL refused when deployToken (the primary) is unset — the NEXT token must not unlock a fail-closed route on its own", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_next_only_fail_closed"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_next_only_fail_closed", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployTokenNext: "next-token-only" }); // deployToken deliberately unset
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer next-token-only" },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(401);
    const body = (await json(res)) as { error: string };
    // The SAME "not configured" remedy as if no token existed at all —
    // proves this is treated exactly like the fully-unconfigured case, not
    // a differentiated "wrong token" 401 (which would mean deployTokenNext
    // was still being consulted as a candidate).
    expect(body.error).toMatch(/AART_DEPLOY_TOKEN/);
    await expect(fx.store.deployments.list({ workflowId: "wf_next_only_fail_closed" })).resolves.toHaveLength(0);
  });

  it("conditionally-gated tier (/runs/trigger): behaves byte-identically to the fully-unconfigured baseline when only deployTokenNext is set — deployToken unset already short-circuits requireDeployTokenIfConfigured before deployTokenNext is ever consulted, so this is a non-regression check, not a hole", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // fully unconfigured baseline
    const baseline = await fetch(`http://localhost:${handle.port}/runs/trigger`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const baselineStatus = baseline.status;
    const baselineBody: unknown = await baseline.json();
    expect(baselineStatus, "this test's own premise is broken if the fully-unconfigured baseline is already 401").not.toBe(401);

    await handle.close();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployTokenNext: "next-token-only" }); // deployToken deliberately unset
    const res = await fetch(`http://localhost:${handle.port}/runs/trigger`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status, "deployTokenNext alone must not change this route's behavior at all").toBe(baselineStatus);
    await expect(res.json()).resolves.toEqual(baselineBody);
  });
});

// D2a security hardening (AMENDMENTS.md A59) — the completeness test: the
// single most important test in this sub-phase (per this session's own
// brief). Converts "a future route silently ships open" (this repo's named
// recurring bug class — A48/A53/A57 FIX1/A58 FIX B all being the SAME
// shape: a real mechanism built but never wired into a real caller) into a
// loud CI failure for THIS specific gap, by enumerating every ACTUALLY
// registered route (Router.getRoutes(), via ServerHandle.getRoutes()) and
// asserting each POST route either carries an explicit `auth` value or is
// named in a small, hardcoded, deliberately-reviewed open-allowlist (the
// three /webhooks/* routes — separate per-binding HMAC verification,
// untouched). A route added to this file in the future that forgets to
// pass `auth` (or add itself to the allowlist, if it's a genuinely-
// intentional new open route) fails THIS test, not a security review.
describe("auth-gate completeness (D2a security hardening, AMENDMENTS.md A59)", () => {
  // The only routes this server intentionally leaves open with no `auth`
  // option at all — a separate, per-binding HMAC mechanism gates these
  // instead (adaptWebhookTrigger/adaptGithubTrigger/adaptSlackTrigger,
  // config.secretResolver), completely unrelated to the deploy token.
  const OPEN_ALLOWLIST = new Set(["POST /webhooks/:bindingId", "POST /webhooks/github/:bindingId", "POST /webhooks/slack/:bindingId"]);

  it("every registered POST route either carries an explicit auth stance or is in the hardcoded open-allowlist (the 3 webhooks)", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const postRoutes = handle.getRoutes().filter((r) => r.method === "POST");
    // Sanity: this test only proves something if there ARE POST routes to
    // check — guards against a future refactor silently emptying the
    // router (and this test passing vacuously as a result).
    expect(postRoutes.length).toBeGreaterThan(15);

    for (const route of postRoutes) {
      const key = `${route.method} ${route.path}`;
      if (OPEN_ALLOWLIST.has(key)) {
        expect(route.auth, `${key} is on the open-allowlist but unexpectedly carries an auth option -- either it's no longer meant to be open (remove it from OPEN_ALLOWLIST) or the auth option was added by mistake`).toBeUndefined();
      } else {
        expect(route.auth, `${key} is NOT on the open-allowlist and has no explicit auth option -- every mutation route must either be gated (pass { auth: ... } at registration) or be a deliberate, reviewed addition to OPEN_ALLOWLIST above (D2a, AMENDMENTS.md A59) -- a route silently shipping open is exactly the recurring bug class this test exists to catch`).toBeDefined();
      }
    }
  });

  // Allowlist entries that DON'T correspond to a real registered route would
  // make the test above vacuously pass for that entry (nothing to check) —
  // this closes that gap the other direction.
  it("every OPEN_ALLOWLIST entry corresponds to a route that actually exists", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const registered = new Set(handle.getRoutes().map((r) => `${r.method} ${r.path}`));
    for (const allowlisted of OPEN_ALLOWLIST) {
      expect(registered.has(allowlisted), `OPEN_ALLOWLIST names "${allowlisted}" but no such route is actually registered`).toBe(true);
    }
  });
});

// D2a security hardening (AMENDMENTS.md A59) — the SAME 4-case pattern the
// promote-gating suite above already established (configured+correct token
// -> unaffected; configured+wrong -> 401; configured+missing header -> 401;
// unconfigured -> unaffected), run once per newly-gated route via a shared
// table instead of 17 near-duplicate describe blocks. "Unaffected" is
// checked by comparing against each route's own natural BASELINE response
// (deployToken unset, no Authorization header) rather than hardcoding an
// assumed status per route — this proves auth wraps around existing
// behavior without altering it; each route's own FUNCTIONAL correctness is
// already exercised elsewhere in this file (or, for the newer flows, is
// exercised by this same request shape 400ing/404ing deterministically —
// every row below uses an empty/placeholder body+params specifically so
// the response is side-effect-free and reproducible, never a real write).
describe("uniform conditional auth gate — every newly-gated write route (D2a security hardening, AMENDMENTS.md A59)", () => {
  const TOKEN = "uniform-gate-token";

  const ROUTES: Array<{ label: string; pathTemplate: string; path: string; body: unknown }> = [
    { label: "POST /runs/trigger", pathTemplate: "/runs/trigger", path: "/runs/trigger", body: {} },
    { label: "POST /approvals/:id/decision", pathTemplate: "/approvals/:id/decision", path: "/approvals/placeholder-id/decision", body: {} },
    { label: "POST /workflows/:id/approve", pathTemplate: "/workflows/:id/approve", path: "/workflows/placeholder-id/approve", body: {} },
    { label: "POST /workflows/:id/block-promotion", pathTemplate: "/workflows/:id/block-promotion", path: "/workflows/placeholder-id/block-promotion", body: {} },
    { label: "POST /workflows/:id/unblock-promotion", pathTemplate: "/workflows/:id/unblock-promotion", path: "/workflows/placeholder-id/unblock-promotion", body: {} },
    { label: "POST /workflows/:id/mark-needs-review", pathTemplate: "/workflows/:id/mark-needs-review", path: "/workflows/placeholder-id/mark-needs-review", body: {} },
    { label: "POST /workflows/:id/clear-needs-review", pathTemplate: "/workflows/:id/clear-needs-review", path: "/workflows/placeholder-id/clear-needs-review", body: {} },
    { label: "POST /workflows/:id/trigger-improvement", pathTemplate: "/workflows/:id/trigger-improvement", path: "/workflows/placeholder-id/trigger-improvement", body: {} },
    { label: "POST /corrections", pathTemplate: "/corrections", path: "/corrections", body: {} },
    { label: "POST /corrections/:key/update-run-output", pathTemplate: "/corrections/:key/update-run-output", path: "/corrections/placeholder-key/update-run-output", body: undefined },
    { label: "POST /corrections/:key/create-eval-example", pathTemplate: "/corrections/:key/create-eval-example", path: "/corrections/placeholder-key/create-eval-example", body: {} },
    { label: "POST /corrections/:key/create-issue", pathTemplate: "/corrections/:key/create-issue", path: "/corrections/placeholder-key/create-issue", body: undefined },
    { label: "POST /evals/suites", pathTemplate: "/evals/suites", path: "/evals/suites", body: {} },
    { label: "POST /evals/runs", pathTemplate: "/evals/runs", path: "/evals/runs", body: {} },
    { label: "POST /runs/:runId/resume", pathTemplate: "/runs/:runId/resume", path: "/runs/placeholder-run/resume", body: {} },
    { label: "POST /runs/:runId/signal", pathTemplate: "/runs/:runId/signal", path: "/runs/placeholder-run/signal", body: {} },
    { label: "POST /runs/:runId/flag/clear", pathTemplate: "/runs/:runId/flag/clear", path: "/runs/placeholder-run/flag/clear", body: {} },
  ];

  it(`this table has exactly the 17 routes this session's brief enumerates (a guard against the table itself silently drifting)`, () => {
    expect(ROUTES).toHaveLength(17);
  });

  for (const route of ROUTES) {
    it(`${route.label}: wrong/missing token -> 401 when configured; correct token, and unconfigured, are BOTH byte-identical to the ungated baseline`, async () => {
      fx = await createTestFixture();
      handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // unconfigured

      // Cross-checks this table's own path template against the REAL
      // registered router state — catches a typo'd path in this test file
      // itself, or a route that silently lost its `auth` option, either of
      // which would otherwise make this test pass for the wrong reason.
      const registered = handle.getRoutes().find((r) => r.method === "POST" && r.path === route.pathTemplate);
      expect(registered, `${route.label}: no registered route matches pathTemplate "${route.pathTemplate}" -- fix this table's pathTemplate to match the real registration in startServer`).toBeDefined();
      expect(registered?.auth, `${route.label}: the real registered route has no auth option at all -- this table asserts it's gated`).toBeDefined();

      const post = (headers: Record<string, string>) =>
        fetch(`http://localhost:${handle!.port}${route.path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
        });

      const baseline = await post({});
      const baselineStatus = baseline.status;
      const baselineBody: unknown = await baseline.json();
      // Sanity: this test's OWN premise is broken if the route already
      // 401s when deployToken is unconfigured (there's no OTHER 401 source
      // on any of these routes when unconfigured -- if this fires, the
      // route itself changed in a way this test needs updating for).
      expect(baselineStatus, `${route.label}: unconfigured baseline was already 401 -- this test's design assumes it isn't`).not.toBe(401);

      await handle.close();
      handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

      const correct = await post({ authorization: `Bearer ${TOKEN}` });
      expect(correct.status, `${route.label}: correct-token response status diverged from the ungated baseline`).toBe(baselineStatus);
      await expect(correct.json(), `${route.label}: correct-token response body diverged from the ungated baseline`).resolves.toEqual(baselineBody);

      const wrong = await post({ authorization: "Bearer wrong-token" });
      expect(wrong.status, `${route.label}: a WRONG token must 401`).toBe(401);

      const missing = await post({});
      expect(missing.status, `${route.label}: a MISSING Authorization header must 401`).toBe(401);
    });
  }
});

describe("POST /bundles/ingest — real ingestion (AMENDMENTS.md A56)", () => {
  const TOKEN = "ingest-test-token";

  it("legacy path (no targetEnvironment): hydrates under the synthetic env_bundle environment, exactly as aart server --bundle already does", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_legacy"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_ingest_legacy", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string; deploymentId: string };
    expect(body.kind).toBe("hydrated");
    expect(body.deploymentId).toBe("bundle:wf_ingest_legacy@1");
    await expect(fx.store.workflows.get("wf_ingest_legacy", "1")).resolves.toBeDefined();
  });

  it("real-environment path: hydrates into an already-registered Environment, env-scoped deploymentId", async () => {
    fx = await createTestFixture();
    await fx.store.environments.put({ id: "env_ingest_real", name: "staging", config: { trustMode: "dev" } });
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_real"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_ingest_real", workflowVersion: "1", targetEnvironment: "staging" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { kind: string; deploymentId: string };
    expect(body.kind).toBe("hydrated");
    expect(body.deploymentId).toBe("bundle:wf_ingest_real@1:env_ingest_real");
    const deployment = await fx.store.deployments.get(body.deploymentId);
    expect(deployment?.promoted).toBe(true); // dev trust mode
  });

  it("an unregistered target environment -> 404 with an actionable remedy, no partial write on the DESTINATION store", async () => {
    // Two independent stores — "source" produces the bundle (so it needs
    // the workflow to build a closure from), "destination" is what the
    // route actually ingests into and never registers "nonexistent" on.
    const source = await createTestFixture();
    await source.store.workflows.put(deployableWorkflow("wf_ingest_bad_env"));
    const bundle = await produceBundle(source.store, { workflowId: "wf_ingest_bad_env", workflowVersion: "1", targetEnvironment: "nonexistent" });
    await source.cleanup();

    fx = await createTestFixture(); // the destination store
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(404);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/aart environment register|POST \/environments/i);
    // No partial write on the destination: neither the definitions nor a
    // Deployment record landed, and "nonexistent" was never auto-vivified.
    await expect(fx.store.workflows.get("wf_ingest_bad_env", "1")).resolves.toBeUndefined();
    await expect(fx.store.deployments.list({ workflowId: "wf_ingest_bad_env" })).resolves.toHaveLength(0);
    await expect(fx.store.environments.getByName("nonexistent")).resolves.toBeUndefined();
  });

  it("a malformed envelope (missing files key) -> 400", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ notFiles: true }),
    });
    expect(res.status).toBe(400);
  });

  it("a tampered bundle (bundleHash mismatch) -> 400", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_tampered"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_ingest_tampered", workflowVersion: "1" });
    const files = bundleToFiles(bundle);
    const manifest = JSON.parse(files["manifest.json"]!) as { bundleHash: string };
    files["manifest.json"] = JSON.stringify({ ...manifest, bundleHash: "0".repeat(64) });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files }),
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/bundleHash mismatch/i);
  });

  it("idempotency: same tuple + same hash -> 200 already_hydrated, no error", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_idem"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_ingest_idem", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const post = () =>
      fetch(`http://localhost:${handle!.port}/bundles/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ files: bundleToFiles(bundle) }),
      });

    const first = await post();
    expect(first.status).toBe(200);
    expect(((await json(first)) as { kind: string }).kind).toBe("hydrated");

    const second = await post();
    expect(second.status).toBe(200);
    expect(((await json(second)) as { kind: string }).kind).toBe("already_hydrated");
  });

  it("idempotency: same tuple + DIFFERENT hash -> 409 conflict, original content preserved", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_conflict", { name: "version A" }));
    const bundleA = await produceBundle(fx.store, { workflowId: "wf_ingest_conflict", workflowVersion: "1" });
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_conflict", { name: "version B (different content, same id@version)" }));
    const bundleB = await produceBundle(fx.store, { workflowId: "wf_ingest_conflict", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const firstRes = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundleA) }),
    });
    expect(firstRes.status).toBe(200);

    const secondRes = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundleB) }),
    });
    expect(secondRes.status).toBe(409);
    await expect(fx.store.workflows.get("wf_ingest_conflict", "1")).resolves.toMatchObject({ name: "version A" });
  });

  it("size cap: a body over MAX_BUNDLE_INGEST_BYTES is rejected 413 before hydration runs", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    // A plain oversized body — 413 fires from the router's Content-Length
    // pre-check before this handler's own JSON parsing / envelope
    // validation ever runs, so the content doesn't need to be a real bundle.
    const oversized = "x".repeat(11 * 1024 * 1024); // 11MB > the 10MB cap
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  it("a body under the size cap is unaffected by the cap", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_ingest_under_cap"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_ingest_under_cap", workflowVersion: "1" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const res = await fetch(`http://localhost:${handle.port}/bundles/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /bundles/plan — zero-write dry-run preview (AMENDMENTS.md A56)", () => {
  const TOKEN = "plan-test-token";

  it("performs ZERO writes — the store is byte-identical before and after", async () => {
    fx = await createTestFixture();
    await fx.store.environments.put({ id: "env_plan_staging", name: "staging", config: { trustMode: "governed" } });
    await fx.store.workflows.put(deployableWorkflow("wf_plan_zero_write"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_zero_write", workflowVersion: "1", targetEnvironment: "staging" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
    // No Deployment was created, no Environment was mutated, and the
    // workflow itself is unaffected — this call read the store, never wrote.
    await expect(fx.store.deployments.list({ workflowId: "wf_plan_zero_write" })).resolves.toHaveLength(0);
    await expect(fx.store.environments.list()).resolves.toHaveLength(1); // still just the one this test set up
  });

  it("returns promotionEligible/unmetGates computed against the bundle's own sealed gates, and gateStatus passed through verbatim", async () => {
    fx = await createTestFixture();
    await fx.store.environments.put({ id: "env_plan_prod", name: "production", config: { trustMode: "production" } });
    // Only validate+humanReview passed — production requires all five, so this is NOT eligible.
    const partialGates = { validate: "passed" as const, readiness: "pending" as const, evals: "pending" as const, riskReview: "pending" as const, humanReview: "passed" as const };
    await fx.store.workflows.put(deployableWorkflow("wf_plan_gates", { gates: partialGates }));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_gates", workflowVersion: "1", targetEnvironment: "production" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
    const plan = (await json(res)) as { promotionEligible: boolean; unmetGates: string[]; gateStatus: Record<string, string>; remedies: string[] };
    expect(plan.promotionEligible).toBe(false);
    expect(plan.unmetGates.sort()).toEqual(["evals", "readiness", "riskReview"]);
    expect(plan.gateStatus).toEqual(partialGates);
    expect(plan.remedies.length).toBeGreaterThan(0);
  });

  it("versionsChanging reports the root workflow as 'added' when it doesn't exist yet on the destination", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_plan_versions"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_versions", workflowVersion: "1" });
    // A second, independent store simulates "the destination has never seen this workflow before."
    const destination = await createTestFixture();
    handle = await startServer({ store: destination.store, engine: destination.engine, clock: destination.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    const plan = (await json(res)) as { versionsChanging: { added: string[]; unchanged: string[] } };
    expect(plan.versionsChanging.added).toEqual(["wf_plan_versions@1"]);
    expect(plan.versionsChanging.unchanged).toEqual([]);
    await destination.cleanup();
  });

  it("an unregistered target environment -> 404, same as ingest's own resolution", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(deployableWorkflow("wf_plan_bad_env"));
    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_bad_env", workflowVersion: "1", targetEnvironment: "does-not-exist" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(404);
  });

  // D1 fix pass (AMENDMENTS.md A57) — integration-level companion to
  // bundle/plan.test.ts's own dedicated, backend-independent regression
  // suite for findCurrentVersion's id tie-break (see that file's own doc
  // comment for why a real createFsStore-backed test CANNOT actually
  // distinguish pre-fix from post-fix behavior — createFsStore's own
  // deployments.list() happens to already return rows sorted alphabetically
  // by id, which coincides with this fix's own tie-break output regardless
  // of whether the fix exists). This test's own job is narrower and
  // genuinely proven here: the real HTTP route surfaces a currentVersion at
  // all when two Deployment rows collide on createdAt (rather than, say,
  // throwing or returning undefined), and that value is stable across
  // repeated requests against the same unchanged store.
  it("currentVersion resolves to a real, stable value over the real HTTP route when two Deployment rows share the exact same createdAt", async () => {
    fx = await createTestFixture();
    await fx.store.environments.put({ id: "env_plan_tie", name: "tie-staging", config: { trustMode: "governed" } });
    await fx.store.workflows.put(deployableWorkflow("wf_plan_tie", { version: "2" }));
    const sameCreatedAt = "2026-07-01T00:00:00.000Z";
    await fx.store.deployments.put({ id: "dep_zzz_last", workflowId: "wf_plan_tie", workflowVersion: "2", environmentId: "env_plan_tie", triggerConfig: {}, createdAt: sameCreatedAt, promoted: true });
    await fx.store.deployments.put({ id: "dep_aaa_first", workflowId: "wf_plan_tie", workflowVersion: "1", environmentId: "env_plan_tie", triggerConfig: {}, createdAt: sameCreatedAt, promoted: true });

    const bundle = await produceBundle(fx.store, { workflowId: "wf_plan_tie", workflowVersion: "2", targetEnvironment: "tie-staging" });
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    expect(res.status).toBe(200);
    const plan = (await json(res)) as { currentVersion?: string };
    expect(["1", "2"]).toContain(plan.currentVersion); // one of the two tied rows, never undefined/thrown

    // Re-request against the SAME unchanged store — must resolve identically every time.
    const res2 = await fetch(`http://localhost:${handle.port}/bundles/plan`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ files: bundleToFiles(bundle) }),
    });
    const plan2 = (await json(res2)) as { currentVersion?: string };
    expect(plan2.currentVersion).toBe(plan.currentVersion);
  });
});

describe("POST /environments — ADR-2 (AMENDMENTS.md A56)", () => {
  const TOKEN = "environments-test-token";

  it("registers a new Environment with the given trustMode, visible via GET /environments", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });

    const res = await fetch(`http://localhost:${handle.port}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "production", trustMode: "production" }),
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { environment: { id: string; name: string; config: Record<string, unknown> } };
    expect(body.environment.name).toBe("production");
    expect(body.environment.config["trustMode"]).toBe("production");

    const listRes = await fetch(`http://localhost:${handle.port}/environments`);
    const listBody = (await json(listRes)) as { environments: Array<{ name: string }> };
    expect(listBody.environments.map((e) => e.name)).toContain("production");
  });

  it("re-registering the same name updates it (upsert), not a duplicate row", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const post = (trustMode: string) =>
      fetch(`http://localhost:${handle!.port}/environments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: "staging", trustMode }),
      });

    await post("governed");
    await post("strict");

    const listRes = await fetch(`http://localhost:${handle.port}/environments`);
    const listBody = (await json(listRes)) as { environments: Array<{ name: string; config: Record<string, unknown> }> };
    const staging = listBody.environments.filter((e) => e.name === "staging");
    expect(staging).toHaveLength(1);
    expect(staging[0]?.config["trustMode"]).toBe("strict");
  });

  it("missing name -> 400", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const res = await fetch(`http://localhost:${handle.port}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ trustMode: "dev" }),
    });
    expect(res.status).toBe(400);
  });

  // D1 fix pass (AMENDMENTS.md A57) — trustMode was cast, never validated;
  // an invalid value (e.g. a typo'd "prod") silently persisted verbatim and
  // every real reader (requiredGatesForEnvironment, normalizeEnvironmentTrustMode)
  // downgrades an unrecognized string to "governed" with no signal anywhere.
  it("invalid trustMode -> 400 naming the four valid values, environment NOT created", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const res = await fetch(`http://localhost:${handle.port}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "prod-typo", trustMode: "prod" }),
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    for (const validMode of ["dev", "governed", "strict", "production"]) {
      expect(body.error).toContain(validMode);
    }
    expect(body.error).toContain('"prod"'); // echoes back what was actually rejected
    await expect(fx.store.environments.getByName("prod-typo")).resolves.toBeUndefined(); // never silently downgraded into existence as "governed"
  });

  it("every valid trustMode (dev/governed/strict/production) is accepted", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    for (const validMode of ["dev", "governed", "strict", "production"]) {
      const res = await fetch(`http://localhost:${handle.port}/environments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ name: `env-${validMode}`, trustMode: validMode }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("omitting trustMode entirely is still accepted (registerEnvironment's own optional-field contract, unchanged)", async () => {
    fx = await createTestFixture();
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: TOKEN });
    const res = await fetch(`http://localhost:${handle.port}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "no-trust-mode-given" }),
    });
    expect(res.status).toBe(200);
  });
});

// D2a security hardening (AMENDMENTS.md A59) — the SAME bug shape D1's fix
// pass (AMENDMENTS.md A57, FIX 2) closed for POST /environments: trustMode
// was cast with no runtime check, so a typo'd value silently persists and
// every real reader downgrades an unrecognized string to "governed" with no
// signal anywhere. Sibling test to /environments' own "invalid trustMode"
// test immediately above.
describe("POST /workflows/:id/approve — trustMode validation (D2a, AMENDMENTS.md A59)", () => {
  it("invalid trustMode -> 400 naming the four valid values, workflow NOT approved", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_approve_trustmode", approval: "draft" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/workflows/wf_approve_trustmode/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0", trustMode: "prod" }),
    });
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    for (const validMode of ["dev", "governed", "strict", "production"]) {
      expect(body.error).toContain(validMode);
    }
    expect(body.error).toContain('"prod"');
    await expect(fx.store.workflows.get("wf_approve_trustmode", "1.0.0")).resolves.toMatchObject({ approval: "draft" }); // unchanged -- never silently downgraded into "governed" and approved anyway
  });

  it("every valid trustMode (dev/governed/strict/production) is accepted", async () => {
    fx = await createTestFixture();
    for (const validMode of ["dev", "governed", "strict", "production"]) {
      await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: `wf_approve_${validMode}`, approval: "draft" }));
    }
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    for (const validMode of ["dev", "governed", "strict", "production"]) {
      const res = await fetch(`http://localhost:${handle.port}/workflows/wf_approve_${validMode}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1.0.0", trustMode: validMode }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("omitting trustMode entirely is still accepted (defaults to governed, unchanged pre-D2a behavior)", async () => {
    fx = await createTestFixture();
    await fx.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_approve_default", approval: "draft" }));
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false });
    const res = await fetch(`http://localhost:${handle.port}/workflows/wf_approve_default/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1.0.0" }),
    });
    expect(res.status).toBe(200);
  });
});

// D2a security hardening, token-derived attribution (AMENDMENTS.md A59) —
// the mechanical half: a decision made with a matching deploy token
// persists ApprovalTask.authenticatedAs; a tokenless-local decision (the
// common case for most real deployments today) leaves it undefined, never
// a false "definitely anonymous" signal.
describe("POST /approvals/:id/decision — token-derived attribution (D2a, AMENDMENTS.md A59)", () => {
  async function approvalSetup(fixture: TestFixture) {
    await fixture.store.workflows.put(fixtureWorkflow("1.0.0", { id: "wf_attribution", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "pending", humanReview: "pending" } }));
    await fixture.store.approvals.put({
      id: "task_attribution",
      runId: "workflow-version:wf_attribution@1.0.0",
      stepId: "__gate:humanReview__",
      title: "t",
      description: "d",
      status: "pending",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
  }

  it("a decision made with a matching deploy token persists authenticatedAs: \"deploy-token\"", async () => {
    fx = await createTestFixture();
    await approvalSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false, deployToken: "attribution-token" });
    const res = await fetch(`http://localhost:${handle.port}/approvals/task_attribution/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer attribution-token" },
      body: JSON.stringify({ status: "approved", reviewer: "alice" }),
    });
    expect(res.status).toBe(200);
    const task = await fx.store.approvals.get("task_attribution");
    expect(task?.authenticatedAs).toBe("deploy-token");
    expect(task?.reviewer).toBe("alice"); // the existing free-text reviewer field is untouched -- both coexist
  });

  it("a tokenless-local decision (deployToken unconfigured) leaves authenticatedAs undefined", async () => {
    fx = await createTestFixture();
    await approvalSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // no deployToken
    const res = await fetch(`http://localhost:${handle.port}/approvals/task_attribution/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "bob" }),
    });
    expect(res.status).toBe(200);
    const task = await fx.store.approvals.get("task_attribution");
    expect(task?.authenticatedAs).toBeUndefined();
    expect(task?.reviewer).toBe("bob");
  });

  it("a client-supplied authenticatedAs in the request body is IGNORED -- attribution can only come from the server's own auth check, never self-reported", async () => {
    fx = await createTestFixture();
    await approvalSetup(fx);
    handle = await startServer({ store: fx.store, engine: fx.engine, clock: fx.clock, port: 0, runTicker: false }); // no deployToken -- so even a matching-looking claim must not stick
    const res = await fetch(`http://localhost:${handle.port}/approvals/task_attribution/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved", reviewer: "eve", authenticatedAs: "deploy-token" }), // self-reported, must be ignored
    });
    expect(res.status).toBe(200);
    const task = await fx.store.approvals.get("task_attribution");
    expect(task?.authenticatedAs).toBeUndefined();
  });
});
