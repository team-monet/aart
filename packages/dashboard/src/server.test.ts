// Integration tests: a real node:http server (via startDashboard), driven
// with real fetch() calls. Unit-level correctness of each view/action
// already lives in views/*.test.ts and stub-deps.test.ts — this file's
// job is proving the ROUTER WIRING itself (right path -> right handler ->
// right status/redirect/body), end to end, for a representative slice of
// every v1/v2/v3 route, using the real stub deps + a real fs-backed store
// (createFakeApiClient reading the same store, standing in for a live S2
// process this worktree doesn't have).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeApiClient } from "./api-client.js";
import { createStubDeps } from "./stub-deps.js";
import { startDashboard, type DashboardHandle } from "./server.js";
import { createTestFixture, makeCorrection, makeEnvironment, makeEvalSuite, makeRun, makeWorkflow, type TestFixture } from "./test-support/fixtures.js";

describe("dashboard HTTP server — route wiring", () => {
  let fixture: TestFixture;
  let handle: DashboardHandle;
  let baseUrl: string;

  beforeEach(async () => {
    fixture = await createTestFixture();
    const api = createFakeApiClient(fixture.store);
    handle = await startDashboard({ store: fixture.store, api, deps: fixture.deps, clock: fixture.clock, port: 0 });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.close();
    await fixture.cleanup();
  });

  it("GET / redirects to /runs", async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/runs");
  });

  it("GET /health reports dashboard liveness", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  describe("v1 read-only pages", () => {
    it("GET /runs lists runs; GET /runs/:id renders the run detail with report HTML embedded", async () => {
      await fixture.store.runs.put(makeRun({ runId: "run-1", status: "completed" }));

      const list = await fetch(`${baseUrl}/runs`);
      expect(list.status).toBe(200);
      expect(await list.text()).toContain("run-1");

      const detail = await fetch(`${baseUrl}/runs/run-1`);
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("run-1");
      expect(detailHtml).toContain('class="run-report"'); // S6 report-renderer seam output

      const missing = await fetch(`${baseUrl}/runs/does-not-exist`);
      expect(missing.status).toBe(404);
    });

    it("GET /workflows lists ids; GET /workflows/:id renders the detail page", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));

      const list = await fetch(`${baseUrl}/workflows`);
      expect(await list.text()).toContain("wf-1");

      const detail = await fetch(`${baseUrl}/workflows/wf-1`);
      expect(detail.status).toBe(200);
      expect(await detail.text()).toContain("1.0.0");
    });

    it("GET /blocks and /packs render honest pending-integration pages", async () => {
      expect((await (await fetch(`${baseUrl}/blocks`)).text())).toContain("Pending");
      expect((await (await fetch(`${baseUrl}/packs`)).text())).toContain("Pending");
    });

    it("GET /artifacts aggregates artifacts across runs", async () => {
      await fixture.store.runs.put(
        makeRun({ runId: "run-art", artifacts: [{ id: "a1", runId: "run-art", name: "out.json", kind: "json_output", mime: "application/json", path: "a1.json", bytes: 10, createdAt: "t" }] }),
      );
      const res = await fetch(`${baseUrl}/artifacts`);
      expect(await res.text()).toContain("out.json");
    });
  });

  describe("v2 writable actions", () => {
    it("trigger workflow: GET the form, POST triggers a run and redirects to it", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-trig", version: "1.0.0" }));

      const form = await fetch(`${baseUrl}/runs/trigger`);
      expect(await form.text()).toContain("wf-trig");

      const res = await fetch(`${baseUrl}/runs/trigger`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "workflowId=wf-trig&workflowVersion=1.0.0&inputs=" + encodeURIComponent(JSON.stringify({ x: 1 })),
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      const location = res.headers.get("location")!;
      expect(location).toMatch(/^\/runs\/run_/);

      const runs = await fixture.store.runs.list({ workflowId: "wf-trig" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("pending");
    });

    it("approve/deprecate: POST recomputes approval and redirects back to the workflow", async () => {
      await fixture.store.workflows.put(
        makeWorkflow({ id: "wf-appr", version: "1.0.0", approval: "draft", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } }),
      );

      const res = await fetch(`${baseUrl}/workflows/wf-appr/approve`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "version=1.0.0&action=approve&trustMode=governed",
        redirect: "manual",
      });

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/workflows/wf-appr");
      expect((await fixture.store.workflows.get("wf-appr", "1.0.0"))?.approval).toBe("approved");
    });

    it("promote: POST promotes when gates are satisfied", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-prom", version: "1.0.0", approval: "approved" }));
      await fixture.store.environments.put(makeEnvironment({ id: "env-prom", config: { trustMode: "dev" } }));

      const res = await fetch(`${baseUrl}/workflows/wf-prom/promote`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "version=1.0.0&environmentId=env-prom",
        redirect: "manual",
      });

      expect(res.status).toBe(303);
      expect(await fixture.store.deployments.list({ workflowId: "wf-prom" })).toHaveLength(1);
    });

    it("view risk diff: POST renders the step diff between two versions", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "1.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.get" }] } }));
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "2.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.get" }, { id: "s2", uses: "email.send" }] } }));

      const res = await fetch(`${baseUrl}/workflows/wf-diff/risk-diff`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "fromVersion=1.0.0&toVersion=2.0.0",
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("email.send");
    });

    it("inspect waiting runs: GET surfaces wait age", async () => {
      await fixture.store.waits.put("run-w", "step1", { type: "manual", schemaVersion: 1 }, fixture.clock.nowIso());
      const res = await fetch(`${baseUrl}/waiting-runs`);
      expect(await res.text()).toContain("run-w");
    });

    it("approve human tasks: POST a decision updates the task and resumes the wait", async () => {
      await fixture.store.runs.put(makeRun({ runId: "run-appr", status: "waiting", waits: [{ type: "approval", taskId: "task-1", schemaVersion: 1 }] }));
      await fixture.store.waits.put("run-appr", "step1", { type: "approval", taskId: "task-1", schemaVersion: 1 }, fixture.clock.nowIso());
      await fixture.store.approvals.put({ id: "task-1", runId: "run-appr", stepId: "step1", title: "Ship?", description: "d", status: "pending", createdAt: fixture.clock.nowIso() });

      const queue = await fetch(`${baseUrl}/approvals`);
      expect(await queue.text()).toContain("Ship?");

      const res = await fetch(`${baseUrl}/approvals/task-1/decision`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "status=approved&reviewer=alice",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect((await fixture.store.approvals.get("task-1"))?.status).toBe("approved");
      expect((await fixture.store.runs.get("run-appr"))?.status).toBe("running");
    });

    it("record correction: POST persists a Correction and redirects to the queue", async () => {
      const res = await fetch(`${baseUrl}/corrections`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "runId=run-1&stepId=step1&fieldPath=outputs.total&observed=1&corrected=2&reason=off+by+one&reviewer=alice",
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(await fixture.store.corrections.list({ runId: "run-1" })).toHaveLength(1);
    });

    it("correction outcomes: update-run-output / create-eval-example / create-issue all reachable by URL-encoded correctionKey", async () => {
      await fixture.store.runs.put(makeRun({ runId: "run-out", workflowId: "wf-out", workflowVersion: "1.0.0", outputs: { total: 1 } }));
      const correction = makeCorrection({ runId: "run-out", stepId: "step1", fieldPath: "outputs.total", corrected: 42 });
      await fixture.store.corrections.put(correction);
      const key = encodeURIComponent("run-out:step1:outputs.total");

      const updateRes = await fetch(`${baseUrl}/corrections/${key}/update-run-output`, { method: "POST", redirect: "manual" });
      expect(updateRes.status).toBe(303);
      expect((await fixture.store.runs.get("run-out"))?.outputs).toEqual({ total: 42 });

      const evalRes = await fetch(`${baseUrl}/corrections/${key}/create-eval-example`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "suiteId=suite-1",
        redirect: "manual",
      });
      expect(evalRes.status).toBe(303);
      expect(await fixture.store.evals.listExamples("suite-1")).toHaveLength(1);

      const issueRes = await fetch(`${baseUrl}/corrections/${key}/create-issue`, { method: "POST" });
      expect(issueRes.status).toBe(200);
      const brief = (await issueRes.json()) as { workflowId: string };
      expect(brief.workflowId).toBe("wf-out");
    });

    it("create eval / run eval: POST creates a suite then runs it", async () => {
      const createRes = await fetch(`${baseUrl}/evals/suites`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "name=My+Suite&scorerKind=exact_match",
        redirect: "manual",
      });
      expect(createRes.status).toBe(303);

      const suites = await fixture.store.evals.listSuites();
      expect(suites).toHaveLength(1);
      await fixture.store.evals.putExample({ id: "ex1", suiteId: suites[0]!.id, input: 1, expected: 1 });
      // putExample alone doesn't attach to suite.examples (separate collections, per AartStore's
      // EvalStore shape) — refresh the suite the way runEvalAction reads it (store.evals.getSuite).
      const refreshedSuite = { ...suites[0]!, examples: await fixture.store.evals.listExamples(suites[0]!.id) };
      await fixture.store.evals.putSuite(refreshedSuite);

      const runRes = await fetch(`${baseUrl}/evals/runs`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `suiteId=${refreshedSuite.id}&workflowId=wf-1&workflowVersion=1.0.0`,
        redirect: "manual",
      });
      expect(runRes.status).toBe(303);
      expect(await fixture.store.evals.listRuns({ suiteId: refreshedSuite.id })).toHaveLength(1);

      const dashboardPage = await fetch(`${baseUrl}/evals`);
      expect(await dashboardPage.text()).toContain("My Suite");
    });
  });

  describe("v3 production additions", () => {
    it("GET /environments, /deployments, /trigger-configs render the corresponding data", async () => {
      await fixture.store.environments.put(makeEnvironment({ id: "env-1", name: "staging" }));
      await fixture.store.deployments.put({ id: "dep-1", workflowId: "wf-1", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: { cron: "0 * * * *" }, createdAt: "t" });

      expect(await (await fetch(`${baseUrl}/environments`)).text()).toContain("staging");
      expect(await (await fetch(`${baseUrl}/deployments`)).text()).toContain("dep-1");
      expect(await (await fetch(`${baseUrl}/trigger-configs`)).text()).toContain("cron");
    });

    it("GET /secrets never renders a secret value", async () => {
      await fixture.store.environments.put(makeEnvironment({ id: "env-s", name: "prod", secretSource: { GITHUB_TOKEN: { path: "/vault/super-secret-value" } } }));
      const html = await (await fetch(`${baseUrl}/secrets`)).text();
      expect(html).toContain("GITHUB_TOKEN");
      expect(html).not.toContain("super-secret-value");
    });

    it("GET /worker-health polls each configured worker and reports an unreachable one distinctly", async () => {
      await handle.close();
      const api = createFakeApiClient(fixture.store, { workerHealth: new Map([["http://worker-ok:8787", { status: "ok", claimedRuns: 1, uptime: 5, version: "0.1.0" }]]) });
      handle = await startDashboard({ store: fixture.store, api, deps: fixture.deps, clock: fixture.clock, port: 0, workerUrls: ["http://worker-ok:8787", "http://worker-down:8787"] });
      baseUrl = `http://127.0.0.1:${handle.port}`;

      const html = await (await fetch(`${baseUrl}/worker-health`)).text();
      expect(html).toContain("worker-ok");
      expect(html).toContain("worker-down");
      expect(html).toContain("unreachable");
    });

    describe("flagged runs — the clear action (architecture §13.3, dashboard/CLI only)", () => {
      it("GET /flagged-runs lists a poison-flagged run; POST .../clear clears it and redirects", async () => {
        await fixture.store.runs.put(makeRun({ runId: "run-flag", status: "failed", flag: { kind: "poison", flaggedAt: fixture.clock.nowIso() } }));

        const list = await fetch(`${baseUrl}/flagged-runs`);
        expect(await list.text()).toContain("run-flag");

        const clearRes = await fetch(`${baseUrl}/flagged-runs/run-flag/clear`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "clearedBy=alice",
          redirect: "manual",
        });
        expect(clearRes.status).toBe(303);
        expect(clearRes.headers.get("location")).toBe("/flagged-runs");

        const cleared = await fixture.store.runs.get("run-flag");
        expect(cleared?.flag?.clearedBy).toBe("alice");
        expect(cleared?.status).toBe("failed"); // clearing never changes run status
      });

      it("POST .../clear on an unflagged run returns 409, not a silent 303", async () => {
        await fixture.store.runs.put(makeRun({ runId: "run-noflag", status: "failed" }));
        const res = await fetch(`${baseUrl}/flagged-runs/run-noflag/clear`, { method: "POST", redirect: "manual" });
        expect(res.status).toBe(409);
      });
    });
  });
});
