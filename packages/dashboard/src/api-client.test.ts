import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, Workflow } from "@aart/types";
import { createFakeApiClient, createHttpApiClient } from "./api-client.js";
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
