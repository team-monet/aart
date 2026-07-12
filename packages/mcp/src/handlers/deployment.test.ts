import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { approvalWaitWorkflowYaml, createTestContext, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "./authoring.js";
import { deployToRemoteHandler, deployWorkflowHandler, listWaitingRunsHandler, resumeRunHandler, triggerWorkflowHandler } from "./deployment.js";
import { runWorkflowHandler } from "./execution.js";

let tc: TestContext;
let remoteServer: Server | undefined;
afterEach(async () => {
  await tc?.cleanup();
  if (remoteServer) await new Promise<void>((resolve) => remoteServer!.close(() => resolve()));
  remoteServer = undefined;
});

/** D1 "remotes + push" (AMENDMENTS.md A56) — a fake HTTP server standing in for a real `aart server`'s /bundles/ingest+/bundles/plan routes, capturing the last request it received. `nextResponse` lets each test script the response deployToRemoteHandler should see. */
function startFakeRemoteServer(): Promise<{ url: string; lastRequest: () => { path: string; authorization: string | undefined; body: unknown } | undefined; setNextResponse: (status: number, body: unknown) => void }> {
  let captured: { path: string; authorization: string | undefined; body: unknown } | undefined;
  let next = { status: 200, body: { ok: true } as unknown };
  remoteServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured = { path: req.url ?? "", authorization: req.headers.authorization, body: raw.length > 0 ? JSON.parse(raw) : undefined };
      res.writeHead(next.status, { "content-type": "application/json" });
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolve, reject) => {
    remoteServer!.once("error", reject);
    remoteServer!.listen(0, () => {
      const address = remoteServer!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://localhost:${port}`,
        lastRequest: () => captured,
        setNextResponse: (status, body) => {
          next = { status, body };
        },
      });
    });
  });
}

async function writeRemote(root: string, name: string, entry: { url: string; environment: string; tokenRef?: string }): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ [name]: entry }), "utf8");
}

async function approveAllGates(ctxStore: TestContext["ctx"]["store"], workflowId: string, version: string) {
  const wf = await ctxStore.workflows.get(workflowId, version);
  await ctxStore.workflows.put({
    ...wf!,
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  });
}

describe("deployWorkflowHandler (aart_deploy_workflow)", () => {
  it("refuses to deploy an unapproved draft", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-1") });
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-1", workflowVersion: "0.1.0", target: "staging" });
    expect(result.ok).toBe(false);
  });

  it("deploys an approved version, auto-creating the target environment", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-2") });
    await approveAllGates(tc.ctx.store, "wf-deploy-2", "0.1.0");
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-2", workflowVersion: "0.1.0", target: "staging" });
    expect(result.ok).toBe(true);
    const environments = await tc.ctx.store.environments.list();
    expect(environments.some((e) => e.name === "staging")).toBe(true);
  });

  it("reuses an existing environment by name rather than creating a duplicate", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-3a") });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-deploy-3b") });
    await approveAllGates(tc.ctx.store, "wf-deploy-3a", "0.1.0");
    await approveAllGates(tc.ctx.store, "wf-deploy-3b", "0.1.0");
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-3a", workflowVersion: "0.1.0", target: "prod" });
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-deploy-3b", workflowVersion: "0.1.0", target: "prod" });
    const environments = await tc.ctx.store.environments.list();
    expect(environments.filter((e) => e.name === "prod")).toHaveLength(1);
  });

  it("fails cleanly when the workflow version doesn't exist", async () => {
    tc = await createTestContext();
    const result = await deployWorkflowHandler(tc.ctx, { workflowId: "nope", workflowVersion: "0.0.0", target: "staging" });
    expect(result.ok).toBe(false);
  });
});

describe("triggerWorkflowHandler (aart_trigger_workflow)", () => {
  it("refuses to trigger a workflow that isn't deployed anywhere", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-trigger-1") });
    const result = await triggerWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-1" });
    expect(result.ok).toBe(false);
  });

  it("triggers a run once the workflow is deployed", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-trigger-2") });
    await approveAllGates(tc.ctx.store, "wf-trigger-2", "0.1.0");
    await deployWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-2", workflowVersion: "0.1.0", target: "staging" });
    const result = await triggerWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-2", input: { url: "https://example.com" } });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("run");
  });

  it("delivers a signal to resume a waiting run", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, {
      workflow: `id: wf-trigger-signal
name: Signal Wait
version: 0.1.0
steps:
  - id: wait
    uses: wait.for_signal
    with:
      name: external-event
      correlationId: corr-1
`,
    });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-trigger-signal" });
    expect(run.status).toBe("waiting");

    const result = await triggerWorkflowHandler(tc.ctx, {
      workflowId: "wf-trigger-signal",
      signal: { name: "external-event", correlationId: "corr-1", payload: { done: true } },
    });
    expect(result.ok).toBe(true);
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("completed");
  });
});

describe("listWaitingRunsHandler (aart_list_waiting_runs)", () => {
  it("lists runs currently waiting, with their wait conditions", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-waiting-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-waiting-1" });
    const result = await listWaitingRunsHandler(tc.ctx, {});
    expect(result.ok).toBe(true);
    const runs = result.runs as { runId: string; waits: unknown[] }[];
    expect(runs.some((r) => r.runId === run.runId)).toBe(true);
    const entry = runs.find((r) => r.runId === run.runId);
    expect(entry?.waits.length).toBeGreaterThan(0);
  });

  it("returns an empty list (still ok:true) when nothing is waiting", async () => {
    tc = await createTestContext();
    const result = await listWaitingRunsHandler(tc.ctx, {});
    expect(result.ok).toBe(true);
    expect(result.runs).toEqual([]);
  });
});

describe("resumeRunHandler (aart_resume_run)", () => {
  it("resumes a waiting run given only the runId (auto-discovers the stepId)", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: approvalWaitWorkflowYaml("wf-resume-1") });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-resume-1" });
    const result = await resumeRunHandler(tc.ctx, { runId: run.runId as string, payload: { decision: "approved" } });
    expect(result.ok).toBe(true);
    const finished = await tc.ctx.store.runs.get(run.runId as string);
    expect(finished?.status).toBe("completed");
  });

  it("fails when nothing is waiting for the given runId", async () => {
    tc = await createTestContext();
    const result = await resumeRunHandler(tc.ctx, { runId: "run_nonexistent" });
    expect(result.ok).toBe(false);
  });

  it("resumes via a matching signal", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, {
      workflow: `id: wf-resume-signal
name: Signal Wait
version: 0.1.0
steps:
  - id: wait
    uses: wait.for_signal
    with:
      name: ext
      correlationId: c1
`,
    });
    const run = await runWorkflowHandler(tc.ctx, { workflowId: "wf-resume-signal" });
    const result = await resumeRunHandler(tc.ctx, { runId: run.runId as string, signal: { name: "ext", correlationId: "c1" } });
    expect(result.ok).toBe(true);
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — the ONE shared handler both
// `aart push` (CLI) and MCP `aart_deploy` route through directly.
describe("deployToRemoteHandler (aart_deploy / aart push)", () => {
  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestContext();
    const result = await deployToRemoteHandler(tc.ctx, { remote: "no-such-remote", workflowId: "wf", workflowVersion: "1" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/aart remote add/i);
  });

  it("produces a bundle scoped to the remote's OWN configured environment (never a caller-supplied one) and POSTs it to /bundles/ingest", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-1") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env" });

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "wf-push-1", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(true);
    expect(remote.lastRequest()?.path).toBe("/bundles/ingest");
    const sentFiles = (remote.lastRequest()?.body as { files: Record<string, string> }).files;
    const manifest = JSON.parse(sentFiles["manifest.json"]!) as { targetEnvironment?: string };
    expect(manifest.targetEnvironment).toBe("staging-env"); // from remotes.json, not a caller input -- deployToRemoteHandler's own input has no environment field at all
  });

  it("--plan (input.plan) targets /bundles/plan instead of /bundles/ingest", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-plan") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env" });

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "wf-push-plan", workflowVersion: "0.1.0", plan: true });
    expect(result.ok).toBe(true);
    expect(result.plan).toBe(true);
    expect(remote.lastRequest()?.path).toBe("/bundles/plan");
  });

  it("resolves the remote's tokenRef and sends it as a Bearer Authorization header, never in the handler's own return value", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-token") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env", tokenRef: "secrets.DEPLOY_TOKEN" });
    await fs.writeFile(join(tc.root, "secrets.json"), JSON.stringify({ DEPLOY_TOKEN: "the-real-token-value" }), "utf8");

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "wf-push-token", workflowVersion: "0.1.0" });
    expect(remote.lastRequest()?.authorization).toBe("Bearer the-real-token-value");
    // The resolved token value must never appear anywhere in the handler's
    // own returned result (it's an MCP tool result an agent/human will see).
    expect(JSON.stringify(result)).not.toContain("the-real-token-value");
  });

  it("a remote with no tokenRef sends no Authorization header at all", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-no-token") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "dev", { url: remote.url, environment: "dev-env" });

    await deployToRemoteHandler(tc.ctx, { remote: "dev", workflowId: "wf-push-no-token", workflowVersion: "0.1.0" });
    expect(remote.lastRequest()?.authorization).toBeUndefined();
  });

  it("surfaces the remote's own error response (e.g. 401) as a failed result with the remote's actual message", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-401") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env" });
    remote.setNextResponse(401, { error: "Unauthorized. This server has no AART_DEPLOY_TOKEN configured." });

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "wf-push-401", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/Unauthorized/);
  });

  it("fails cleanly with a remedy when the remote host is unreachable", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-unreachable") });
    await writeRemote(tc.root, "broken", { url: "http://localhost:1", environment: "x" }); // port 1: reserved/unreachable in test environments

    const result = await deployToRemoteHandler(tc.ctx, { remote: "broken", workflowId: "wf-push-unreachable", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach remote/i);
  });

  it("fails cleanly when the workflow@version doesn't exist", async () => {
    tc = await createTestContext();
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env" });

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "no-such-wf", workflowVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    expect(remote.lastRequest()).toBeUndefined(); // never even attempted the network call
  });

  it("surfaces the remote's successful response fields (e.g. deploymentId) directly in the returned result", async () => {
    tc = await createTestContext();
    await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-push-fields") });
    const remote = await startFakeRemoteServer();
    await writeRemote(tc.root, "staging", { url: remote.url, environment: "staging-env" });
    remote.setNextResponse(200, { kind: "hydrated", workflowId: "wf-push-fields", workflowVersion: "0.1.0", deploymentId: "bundle:wf-push-fields@0.1.0:env_x" });

    const result = await deployToRemoteHandler(tc.ctx, { remote: "staging", workflowId: "wf-push-fields", workflowVersion: "0.1.0" });
    expect(result.ok).toBe(true);
    expect(result.deploymentId).toBe("bundle:wf-push-fields@0.1.0:env_x");
    expect(result.kind).toBe("hydrated");
  });
});
