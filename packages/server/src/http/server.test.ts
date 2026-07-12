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
});
