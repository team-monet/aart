import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, Workflow } from "@aart/types";
import { createFakeEngine, startServer, type ServerHandle } from "@aart/server";
import { createFsStore } from "@aart/store";
import { createFakeApiClient, createHttpApiClient } from "./api-client.js";
import { createFakeClock } from "./clock.js";
import { createTestFixture, makeRun, makeWorkflow } from "./test-support/fixtures.js";

describe("createFakeApiClient (store-backed, local/embedded topology)", () => {
  it("reads runs, waiting runs, flagged runs, workflow ids, environments, deployments, and rejected triggers straight from the store", async () => {
    const { store, cleanup } = await createTestFixture();
    try {
      const flagged = makeRun({ runId: "r-flag", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } });
      await store.runs.put(flagged);
      await store.runs.put(makeRun({ runId: "r-ok", status: "completed" }));
      await store.environments.put({ id: "env-1", name: "staging", config: {} });
      await store.deployments.put({ id: "dep-1", workflowId: "wf-1", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: {}, createdAt: "2026-07-10T00:00:00.000Z" });
      await store.rejectedTriggers.append({ id: "rej-1", triggerType: "webhook", reason: "bad_hmac", rawPayload: {}, receivedAt: "2026-07-10T00:00:00.000Z" });

      const client = createFakeApiClient(store);

      expect((await client.listRuns()).map((r) => r.runId).sort()).toEqual(["r-flag", "r-ok"]);
      expect(await client.getRun("r-ok")).toMatchObject({ runId: "r-ok" });
      expect(await client.getRun("nope")).toBeUndefined();
      expect((await client.listFlaggedRunsViaApi()).map((r) => r.runId)).toEqual(["r-flag"]);
      expect(await client.listEnvironments()).toHaveLength(1);
      expect(await client.listDeployments()).toHaveLength(1);
      expect(await client.listRejectedTriggers()).toHaveLength(1);
      expect(await client.controlPlaneHealth()).toEqual({ status: "ok" });
    } finally {
      await cleanup();
    }
  });

  it("workerHealth returns a registered fake and throws for an unregistered worker URL", async () => {
    const { store, cleanup } = await createTestFixture();
    try {
      const client = createFakeApiClient(store, { workerHealth: new Map([["http://worker-1:8787", { status: "ok", claimedRuns: 2, uptime: 100, version: "0.1.0" }]]) });
      expect(await client.workerHealth("http://worker-1:8787")).toEqual({ status: "ok", claimedRuns: 2, uptime: 100, version: "0.1.0" });
      await expect(client.workerHealth("http://worker-2:8787")).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("getWorkflow reads the latest (or a specific) version plus version history straight from the store, undefined when missing (root AMENDMENTS.md A43)", async () => {
    const { store, cleanup } = await createTestFixture();
    try {
      await store.workflows.put(makeWorkflow({ id: "wf-detail", version: "1.0.0" }));
      await store.workflows.put(makeWorkflow({ id: "wf-detail", version: "2.0.0", approval: "approved" }));
      const client = createFakeApiClient(store);

      const latest = await client.getWorkflow("wf-detail");
      expect(latest?.workflow.version).toBe("2.0.0");
      expect(latest?.workflow.approval).toBe("approved");
      expect(latest?.versions).toEqual(["1.0.0", "2.0.0"]);

      const specific = await client.getWorkflow("wf-detail", "1.0.0");
      expect(specific?.workflow.version).toBe("1.0.0");

      expect(await client.getWorkflow("no-such-workflow")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // AMENDMENTS.md A47: writes — the fake client now calls the SAME real
  // functions the HTTP client's server-side endpoints call
  // (`@aart/server`'s `decideApprovalTask`/`approveOrDeprecateWorkflow`/
  // `promoteWorkflowVersionToEnvironment`/`createEvalSuite`/
  // `runEvalSuiteForWorkflow`, `@aart/evidence`'s correction-outcome
  // functions) rather than a dashboard-local reimplementation of each.
  describe("writes (AMENDMENTS.md A47)", () => {
    it("listApprovals / decideApproval: a riskReview decision writes gates.riskReview, not gates.humanReview (root AMENDMENTS.md A46)", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.workflows.put(makeWorkflow({ id: "wf-gate", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" } }));
        await store.approvals.put({ id: "task-risk", runId: "workflow-version:wf-gate@1.0.0", stepId: "__gate:riskReview__", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
        const client = createFakeApiClient(store);

        expect((await client.listApprovals("pending")).map((t) => t.id)).toEqual(["task-risk"]);

        const result = await client.decideApproval("task-risk", { status: "approved", reviewer: "alice" });
        expect(result.kind).toBe("workflow_version");
        if (result.kind !== "workflow_version") throw new Error("unreachable");
        expect(result.gates.riskReview).toBe("passed");
        expect(result.gates.humanReview).toBe("pending");

        const persisted = await store.workflows.get("wf-gate", "1.0.0");
        expect(persisted?.gates.riskReview).toBe("passed");
        expect(persisted?.gates.humanReview).toBe("pending");
      } finally {
        await cleanup();
      }
    });

    it("triggerRun starts a real run (via the fake engine boundary) and persists + enqueues it", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.workflows.put(makeWorkflow({ id: "wf-trig", version: "1.0.0" }));
        const client = createFakeApiClient(store);

        const run = await client.triggerRun({ workflowId: "wf-trig", workflowVersion: "1.0.0", inputs: { x: 1 } });

        expect(run.workflowId).toBe("wf-trig");
        expect(run.status).toBe("pending");
        expect(await store.runs.get(run.runId)).toEqual(run);
        await expect(store.jobQueue.get(run.runId)).resolves.toBeDefined();
      } finally {
        await cleanup();
      }
    });

    it("triggerRun throws for an unknown workflow", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        const client = createFakeApiClient(store);
        await expect(client.triggerRun({ workflowId: "nope", inputs: {} })).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("approveOrDeprecateWorkflow / promoteWorkflow / block-unblock-promotion / mark-clear-needs-review round-trip through the real @aart/server + @aart/evidence functions", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.workflows.put(makeWorkflow({ id: "wf-actions", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));
        await store.environments.put({ id: "env-actions", name: "staging", config: { trustMode: "dev" } });
        const client = createFakeApiClient(store);

        const approved = await client.approveOrDeprecateWorkflow("wf-actions", "1.0.0", "approve", "governed");
        expect(approved.approval).toBe("approved");

        const promoted = await client.promoteWorkflow("wf-actions", "1.0.0", "env-actions");
        expect(promoted.kind).toBe("promoted");

        await client.blockPromotion("wf-actions", "1.0.0");
        expect((await store.workflows.get("wf-actions", "1.0.0"))?.promotionBlocked).toBe(true);
        await client.unblockPromotion("wf-actions", "1.0.0");
        expect((await store.workflows.get("wf-actions", "1.0.0"))?.promotionBlocked).toBe(false);

        await client.markNeedsReview("wf-actions", "1.0.0");
        expect((await store.workflows.get("wf-actions", "1.0.0"))?.needsReview).toBe(true);
        await client.clearNeedsReview("wf-actions", "1.0.0");
        expect((await store.workflows.get("wf-actions", "1.0.0"))?.needsReview).toBe(false);

        const brief = await client.triggerImprovementProposal("wf-actions", "1.0.0");
        expect(brief.workflowId).toBe("wf-actions");
      } finally {
        await cleanup();
      }
    });

    it("recordCorrection / listCorrections / updateCorrectionRunOutput / createEvalExampleFromCorrection / createIssueForCorrection", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.runs.put(
          makeRun({ runId: "run-c", workflowId: "wf-c", workflowVersion: "1.0.0", trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { total: 1 }, startedAt: "t" }] }),
        );
        const client = createFakeApiClient(store);

        const correction = await client.recordCorrection({ runId: "run-c", stepId: "step1", fieldPath: "outputs.total", observed: 1, corrected: 42, reason: "off by one", reviewer: "alice" });
        expect((await client.listCorrections({ runId: "run-c" }))).toEqual([correction]);

        const key = "run-c:step1:outputs.total";
        const updatedRun = await client.updateCorrectionRunOutput(key);
        expect(updatedRun?.trace[0]?.outputs).toEqual({ total: 42 });
        expect(await client.updateCorrectionRunOutput("no-such:key:here")).toBeUndefined();

        const example = await client.createEvalExampleFromCorrection(key, "suite-1");
        expect(example?.suiteId).toBe("suite-1");
        expect(await client.createEvalExampleFromCorrection("no-such:key:here", "suite-1")).toBeUndefined();

        const brief = await client.createIssueForCorrection(key);
        expect(brief?.workflowId).toBe("wf-c");
        expect(await client.createIssueForCorrection("no-such:key:here")).toBeUndefined();
      } finally {
        await cleanup();
      }
    });

    it("createEvalSuite / runEvalSuite / listEvals: creates a suite, runs it with the real scorer registry, persists the EvalRun", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.workflows.put(makeWorkflow({ id: "wf-eval", version: "1.0.0" }));
        const client = createFakeApiClient(store);

        const suite = await client.createEvalSuite({ name: "My Suite", scorer: { id: "s1", kind: "exact_match" } });
        await store.evals.putExample({ id: "ex1", suiteId: suite.id, input: 5, expected: 5 });

        const result = await client.runEvalSuite(suite.id, "wf-eval", "1.0.0");
        expect(result.evalRun.passed).toBe(1);

        const { suites, runs } = await client.listEvals();
        expect(suites.map((s) => s.id)).toContain(suite.id);
        expect(runs).toHaveLength(1);

        await expect(client.runEvalSuite("no-such-suite", "wf-eval", "1.0.0")).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("clearRunFlag: cleared / no_flag / not_found", async () => {
      const { store, cleanup } = await createTestFixture();
      try {
        await store.runs.put(makeRun({ runId: "run-flag", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" } }));
        await store.runs.put(makeRun({ runId: "run-noflag", status: "completed" }));
        const client = createFakeApiClient(store);

        const cleared = await client.clearRunFlag("run-flag", "alice");
        expect(cleared.kind).toBe("cleared");
        expect(await client.clearRunFlag("run-noflag", "alice")).toEqual({ kind: "no_flag" });
        expect(await client.clearRunFlag("no-such-run", "alice")).toEqual({ kind: "not_found" });
      } finally {
        await cleanup();
      }
    });
  });
});

describe("createHttpApiClient against a REAL @aart/server instance (AMENDMENTS.md A47 — end-to-end, no hand-rolled response mocking, proving the dashboard's writes genuinely reach the server's own real functions)", () => {
  let handle: ServerHandle;
  let baseUrl: string;
  let cleanupStore: () => Promise<void>;

  /** `deployToken` (D1 fix pass, AMENDMENTS.md A57) — optional, omitted by every pre-existing caller below (byte-identical to this helper's pre-A57 behavior); the new promote-gating tests pass it explicitly to exercise a token-configured real server. */
  async function startRealServer(deployToken?: string) {
    const { store, cleanup } = await createTestFixture(); // dashboard's own fixture — a real fs-backed store
    cleanupStore = cleanup;
    const clock = createFakeClock();
    const engine = createFakeEngine(store, { ...clock, setTimeout: () => ({ cancel() {} }) });
    handle = await startServer({ store, engine, clock: { ...clock, setTimeout: () => ({ cancel() {} }) }, port: 0, runTicker: false, deployToken });
    baseUrl = `http://127.0.0.1:${handle.port}`;
    return store;
  }

  afterEach(async () => {
    await handle?.close();
    await cleanupStore?.();
  });

  it("triggerRun / approveOrDeprecateWorkflow / promoteWorkflow / block-mark flags / triggerImprovementProposal all round-trip over real HTTP", async () => {
    const store = await startRealServer();
    await store.workflows.put(makeWorkflow({ id: "wf-http", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" }, approval: "approved" }));
    await store.environments.put({ id: "env-http", name: "staging", config: { trustMode: "dev" } });
    const client = createHttpApiClient(baseUrl);

    const run = await client.triggerRun({ workflowId: "wf-http", workflowVersion: "1.0.0", inputs: {} });
    expect(run.workflowId).toBe("wf-http");

    const approved = await client.approveOrDeprecateWorkflow("wf-http", "1.0.0", "approve", "governed");
    expect(approved.approval).toBe("approved");

    const promoted = await client.promoteWorkflow("wf-http", "1.0.0", "env-http");
    expect(promoted.kind).toBe("promoted");

    await client.blockPromotion("wf-http", "1.0.0");
    expect((await store.workflows.get("wf-http", "1.0.0"))?.promotionBlocked).toBe(true);
    await client.markNeedsReview("wf-http", "1.0.0");
    expect((await store.workflows.get("wf-http", "1.0.0"))?.needsReview).toBe(true);

    const brief = await client.triggerImprovementProposal("wf-http", "1.0.0");
    expect(brief.workflowId).toBe("wf-http");
  });

  it("decideApproval over real HTTP: humanReview and riskReview decide independently (root AMENDMENTS.md A46's fix, exercised end-to-end)", async () => {
    const store = await startRealServer();
    await store.workflows.put(makeWorkflow({ id: "wf-gates", version: "1.0.0", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "pending", humanReview: "pending" } }));
    await store.approvals.put({ id: "task-h", runId: "workflow-version:wf-gates@1.0.0", stepId: "__gate:humanReview__", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
    await store.approvals.put({ id: "task-r", runId: "workflow-version:wf-gates@1.0.0", stepId: "__gate:riskReview__", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
    const client = createHttpApiClient(baseUrl);

    const riskResult = await client.decideApproval("task-r", { status: "approved", reviewer: "alice", trustMode: "production" });
    expect(riskResult.kind).toBe("workflow_version");
    if (riskResult.kind !== "workflow_version") throw new Error("unreachable");
    expect(riskResult.gates.riskReview).toBe("passed");
    expect(riskResult.gates.humanReview).toBe("pending");

    const humanResult = await client.decideApproval("task-h", { status: "approved", reviewer: "bob", trustMode: "production" });
    expect(humanResult.kind).toBe("workflow_version");
    if (humanResult.kind !== "workflow_version") throw new Error("unreachable");
    expect(humanResult.gates.riskReview).toBe("passed");
    expect(humanResult.gates.humanReview).toBe("passed");
    expect(humanResult.approval).toBe("approved"); // production requires all 5; all now satisfied
  });

  it("correction record + outcomes, eval create + run, and clearRunFlag round-trip over real HTTP", async () => {
    const store = await startRealServer();
    await store.runs.put(
      makeRun({ runId: "run-http", workflowId: "wf-http-corr", workflowVersion: "1.0.0", status: "failed", flag: { kind: "poison", flaggedAt: "2026-07-09T00:00:00.000Z" }, trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { total: 1 }, startedAt: "t" }] }),
    );
    await store.workflows.put(makeWorkflow({ id: "wf-http-eval", version: "1.0.0" }));
    const client = createHttpApiClient(baseUrl);

    const correction = await client.recordCorrection({ runId: "run-http", stepId: "step1", fieldPath: "outputs.total", observed: 1, corrected: 42, reason: "off by one", reviewer: "alice" });
    expect(correction.runId).toBe("run-http");
    const key = "run-http:step1:outputs.total";
    const updatedRun = await client.updateCorrectionRunOutput(key);
    expect(updatedRun?.trace[0]?.outputs).toEqual({ total: 42 });

    const suite = await client.createEvalSuite({ name: "HTTP Suite", scorer: { id: "s1", kind: "exact_match" } });
    const evalResult = await client.runEvalSuite(suite.id, "wf-http-eval", "1.0.0");
    expect(evalResult.evalRun.suiteId).toBe(suite.id);
    const { suites } = await client.listEvals();
    expect(suites.map((s) => s.id)).toContain(suite.id);

    const clearResult = await client.clearRunFlag("run-http", "ops");
    expect(clearResult.kind).toBe("cleared");
  });

  it("listApprovals / listCorrections read through the real server, not any local store", async () => {
    const store = await startRealServer();
    await store.approvals.put({ id: "at-1", runId: "run-x", stepId: "s", title: "t", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
    await store.corrections.put({ runId: "run-x", stepId: "s", fieldPath: "outputs.a", observed: 1, corrected: 2, reason: "r", reviewer: "alice", createdAt: "2026-07-10T00:00:00.000Z" });
    const client = createHttpApiClient(baseUrl);

    expect((await client.listApprovals()).map((t) => t.id)).toEqual(["at-1"]);
    expect((await client.listCorrections()).map((c) => c.runId)).toEqual(["run-x"]);
  });

  // D1 fix pass (AMENDMENTS.md A57) — the server's requireDeployTokenIfConfigured
  // conditionally requires a Bearer token on POST /workflows/:id/promote once
  // AART_DEPLOY_TOKEN is configured server-side; createHttpApiClient's own
  // deployToken parameter is this dashboard hop's answer to that gate.
  it("promoteWorkflow attaches the configured deployToken as a Bearer header and succeeds against a token-gated real server", async () => {
    const store = await startRealServer("dashboard-promote-token");
    await store.workflows.put(makeWorkflow({ id: "wf-http-gated", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" }, approval: "approved" }));
    await store.environments.put({ id: "env-http-gated", name: "gated", config: { trustMode: "dev" } });
    const client = createHttpApiClient(baseUrl, "dashboard-promote-token");

    const promoted = await client.promoteWorkflow("wf-http-gated", "1.0.0", "env-http-gated");
    expect(promoted.kind).toBe("promoted");
  });

  it("promoteWorkflow WITHOUT a deployToken fails (throws) against a token-gated real server — proves the header is actually load-bearing, not a no-op", async () => {
    const store = await startRealServer("dashboard-promote-token");
    await store.workflows.put(makeWorkflow({ id: "wf-http-gated-2", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" }, approval: "approved" }));
    await store.environments.put({ id: "env-http-gated-2", name: "gated2", config: { trustMode: "dev" } });
    const client = createHttpApiClient(baseUrl); // no deployToken given to the dashboard client

    await expect(client.promoteWorkflow("wf-http-gated-2", "1.0.0", "env-http-gated-2")).rejects.toThrow(/401/);
  });
});

describe("createHttpApiClient (real fetch, against S2's documented route shapes)", () => {
  let server: Server;
  let baseUrl: string;
  const run: RunRecord = makeRun({ runId: "http-run-1" });
  const workflow: Workflow = makeWorkflow({ id: "wf-detail", version: "2.0.0" });

  function start(): Promise<void> {
    return new Promise((resolve) => {
      server = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/runs" && req.method === "GET") {
          expect(url.searchParams.get("status")).toBe("failed");
          res.end(JSON.stringify({ runs: [run] }));
          return;
        }
        if (url.pathname === "/runs/http-run-1") {
          res.end(JSON.stringify({ run }));
          return;
        }
        if (url.pathname === "/runs/missing") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (url.pathname === "/waiting-runs") {
          res.end(JSON.stringify({ waits: [{ runId: "r1", stepId: "s1", wait: { type: "manual", schemaVersion: 1 }, createdAt: "2026-07-01T00:00:00.000Z" }] }));
          return;
        }
        if (url.pathname === "/flagged-runs") {
          res.end(JSON.stringify({ runs: [run] }));
          return;
        }
        if (url.pathname === "/workflows") {
          res.end(JSON.stringify({ workflowIds: ["wf-1", "wf-2"] }));
          return;
        }
        if (url.pathname === "/workflows/wf-detail") {
          const version = url.searchParams.get("version");
          res.end(JSON.stringify({ workflow: version ? { ...workflow, version } : workflow, versions: ["1.0.0", "2.0.0"] }));
          return;
        }
        if (url.pathname === "/workflows/missing") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (url.pathname === "/environments") {
          res.end(JSON.stringify({ environments: [{ id: "env-1", name: "staging", config: {} }] }));
          return;
        }
        if (url.pathname === "/deployments") {
          res.end(JSON.stringify({ deployments: [] }));
          return;
        }
        if (url.pathname === "/rejected-triggers") {
          res.end(JSON.stringify({ rejected: [] }));
          return;
        }
        if (url.pathname === "/health") {
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      });
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  afterEach(() => {
    return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it("issues GET /runs?status= and parses {runs}", async () => {
    await start();
    const client = createHttpApiClient(baseUrl);
    const runs = await client.listRuns({ status: "failed" });
    expect(runs).toEqual([run]);
  });

  it("issues GET /runs/:id and parses {run}, returning undefined on 404", async () => {
    await start();
    const client = createHttpApiClient(baseUrl);
    expect(await client.getRun("http-run-1")).toEqual(run);
    expect(await client.getRun("missing")).toBeUndefined();
  });

  it("issues GET /workflows/:id (optionally ?version=) and parses {workflow, versions}, returning undefined on 404 (root AMENDMENTS.md A43)", async () => {
    await start();
    const client = createHttpApiClient(baseUrl);

    const latest = await client.getWorkflow("wf-detail");
    expect(latest?.workflow.id).toBe("wf-detail");
    expect(latest?.workflow.version).toBe("2.0.0");
    expect(latest?.versions).toEqual(["1.0.0", "2.0.0"]);

    const specific = await client.getWorkflow("wf-detail", "1.0.0");
    expect(specific?.workflow.version).toBe("1.0.0");

    expect(await client.getWorkflow("missing")).toBeUndefined();
  });

  it("issues GET /waiting-runs, /flagged-runs, /workflows, /environments, /deployments, /rejected-triggers, /health", async () => {
    await start();
    const client = createHttpApiClient(baseUrl);
    expect(await client.listWaitingRuns()).toHaveLength(1);
    expect(await client.listFlaggedRunsViaApi()).toEqual([run]);
    expect(await client.listWorkflowIds()).toEqual(["wf-1", "wf-2"]);
    expect(await client.listEnvironments()).toHaveLength(1);
    expect(await client.listDeployments()).toEqual([]);
    expect(await client.listRejectedTriggers()).toEqual([]);
    expect(await client.controlPlaneHealth()).toEqual({ status: "ok" });
  });

  it("workerHealth GETs {workerUrl}/health directly (unwrapped HealthPayload, distinct from control-plane /health)", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: "ok", claimedRuns: 3, uptime: 12.5, version: "0.1.0" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const client = createHttpApiClient("http://unused-base");
    const health = await client.workerHealth(`http://127.0.0.1:${port}`);
    expect(health).toEqual({ status: "ok", claimedRuns: 3, uptime: 12.5, version: "0.1.0" });
  });
});
