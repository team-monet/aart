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

    it("GET /workflows lists ids; GET /workflows/:id renders the detail page, including version history and recent runs (root AMENDMENTS.md A43)", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "2.0.0" }));
      await fixture.store.runs.put(makeRun({ runId: "run-for-wf-1", workflowId: "wf-1", workflowVersion: "1.0.0" }));

      const list = await fetch(`${baseUrl}/workflows`);
      expect(await list.text()).toContain("wf-1");

      const detail = await fetch(`${baseUrl}/workflows/wf-1`);
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("2.0.0"); // latest by default
      expect(detailHtml).toContain('<a href="/workflows/wf-1?version=1.0.0">1.0.0</a>'); // version history, drill-down link
      expect(detailHtml).toContain('<a href="/runs/run-for-wf-1">run-for-wf-1</a>'); // recent runs

      const specificVersion = await fetch(`${baseUrl}/workflows/wf-1?version=1.0.0`);
      expect(await specificVersion.text()).toContain("<strong>1.0.0</strong> (viewing)");

      const missing = await fetch(`${baseUrl}/workflows/no-such-workflow`);
      expect(missing.status).toBe(404);
    });

    // The exact bug a founder's real local test drive hit (root
    // AMENDMENTS.md A43): TEST-DRIVE.md's example launch script builds the
    // dashboard's OWN `store` handle from a hand-typed `.aart` path
    // independent of the one the real `aart server` process (fronted here
    // by `api`) actually uses — get that path wrong (as the founder's own
    // copy-pasted script did) and the OLD store-direct read 404'd on a
    // workflow that demonstrably existed. Proves the fix: `store` below is
    // deliberately EMPTY (no "wf-divergent" anywhere in it) while `api`
    // fronts a SEPARATE store that has the real data — workflow detail must
    // still render, because it no longer reads `store` at all.
    it("workflow detail reads through `api`, not the dashboard's own local `store` — a misconfigured/empty local store no longer breaks the page as long as the real data is reachable via the API boundary", async () => {
      const real = await createTestFixture();
      try {
        await real.store.workflows.put(makeWorkflow({ id: "wf-divergent", version: "1.0.0" }));

        await handle.close();
        handle = await startDashboard({ store: fixture.store, api: createFakeApiClient(real.store), deps: fixture.deps, clock: fixture.clock, port: 0 });
        baseUrl = `http://127.0.0.1:${handle.port}`;

        expect(await fixture.store.workflows.getLatest("wf-divergent")).toBeUndefined(); // this test's own dashboard-local store genuinely has no such workflow

        const res = await fetch(`${baseUrl}/workflows/wf-divergent`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("1.0.0");
      } finally {
        await real.cleanup();
      }
    });

    // AMENDMENTS.md A47: the SAME divergent-store proof above (root
    // AMENDMENTS.md A43's exact scenario), extended to EVERY OTHER
    // data-bearing route this session migrated off direct `store` access —
    // reads (approvals/corrections/evals lists, previously store-direct)
    // AND writes (trigger a run, decide an approval, record a correction —
    // previously `deps.X(store, ...)` against this SAME divergent local
    // store). `fixture.store` (this dashboard instance's own configured
    // store) is asserted empty throughout; every effect must land in
    // `real.store` (fronted only by `api`) instead — proving the dashboard
    // genuinely has NO functional dependency left on its own local store
    // for any of these, not just workflow/block detail.
    it("every remaining v1/v2/v3 read AND write goes through `api`, never the dashboard's own divergent local `store` (root AMENDMENTS.md A43, extended A47)", async () => {
      const real = await createTestFixture();
      try {
        await real.store.workflows.put(makeWorkflow({ id: "wf-div2", version: "1.0.0", gates: { validate: "passed", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "passed" } }));
        await real.store.approvals.put({ id: "at-div", runId: "run-div", stepId: "step1", title: "Ship?", description: "d", status: "pending", createdAt: "2026-07-10T00:00:00.000Z" });
        await real.store.runs.put(makeRun({ runId: "run-div", status: "waiting", waits: [{ type: "approval", taskId: "at-div", schemaVersion: 1 }] }));
        await real.store.waits.put("run-div", "step1", { type: "approval", taskId: "at-div", schemaVersion: 1 }, "2026-07-10T00:00:00.000Z");
        await real.store.corrections.put({ runId: "run-div", stepId: "step1", fieldPath: "outputs.x", observed: 1, corrected: 2, reason: "r", reviewer: "alice", createdAt: "2026-07-10T00:00:00.000Z" });
        await real.store.evals.putSuite({ id: "suite-div", name: "S", examples: [], scorer: { id: "s1", kind: "exact_match" }, tags: [] });

        await handle.close();
        handle = await startDashboard({ store: fixture.store, api: createFakeApiClient(real.store), deps: fixture.deps, clock: fixture.clock, port: 0 });
        baseUrl = `http://127.0.0.1:${handle.port}`;

        // Reads: fixture.store (this dashboard instance's OWN store) is
        // empty of all of the above — every response below can ONLY have
        // come from `real.store`, via `api`.
        expect(await fixture.store.workflows.getLatest("wf-div2")).toBeUndefined();
        expect(await fixture.store.approvals.list()).toEqual([]);
        expect(await fixture.store.corrections.list()).toEqual([]);
        expect(await fixture.store.evals.listSuites()).toEqual([]);

        expect(await (await fetch(`${baseUrl}/approvals`)).text()).toContain("Ship?");
        expect(await (await fetch(`${baseUrl}/corrections`)).text()).toContain("run-div");
        expect(await (await fetch(`${baseUrl}/evals`)).text()).toContain("S</td>");

        // Writes: trigger a run, decide an approval, record a correction —
        // every effect must land in real.store, and fixture.store must stay
        // untouched throughout.
        const triggerRes = await fetch(`${baseUrl}/runs/trigger`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "workflowId=wf-div2&workflowVersion=1.0.0&inputs=%7B%7D",
          redirect: "manual",
        });
        expect(triggerRes.status).toBe(303);
        expect(await real.store.runs.list({ workflowId: "wf-div2" })).toHaveLength(1);
        expect(await fixture.store.runs.list({ workflowId: "wf-div2" })).toHaveLength(0);

        const decideRes = await fetch(`${baseUrl}/approvals/at-div/decision`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "status=approved&reviewer=alice",
          redirect: "manual",
        });
        expect(decideRes.status).toBe(303);
        expect((await real.store.approvals.get("at-div"))?.status).toBe("approved");
        expect(await fixture.store.approvals.get("at-div")).toBeUndefined();

        const correctRes = await fetch(`${baseUrl}/corrections`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "runId=run-div&stepId=step1&fieldPath=outputs.y&observed=1&corrected=2&reason=r&reviewer=alice",
          redirect: "manual",
        });
        expect(correctRes.status).toBe(303);
        expect(await real.store.corrections.list({ runId: "run-div", stepId: "step1" })).toHaveLength(2); // the fixture-seeded one + this new one
        expect(await fixture.store.corrections.list()).toEqual([]);
      } finally {
        await real.cleanup();
      }
    });

    it("GET /blocks renders the real block catalog; GET /blocks/:id renders one block's manifest (root AMENDMENTS.md A43 — no route existed at all before); GET /packs stays an honest pending-integration page (reconciliation ledger item 13)", async () => {
      const blocksHtml = await (await fetch(`${baseUrl}/blocks`)).text();
      expect(blocksHtml).toContain("http.request");
      expect(blocksHtml).toContain("block(s)");
      expect(blocksHtml).toContain('<a href="/blocks/http.request">http.request</a>');

      const detail = await fetch(`${baseUrl}/blocks/http.request`);
      expect(detail.status).toBe(200);
      const detailHtml = await detail.text();
      expect(detailHtml).toContain("http.request");
      expect(detailHtml).toContain("Input Schema");

      const missing = await fetch(`${baseUrl}/blocks/no.such.block`);
      expect(missing.status).toBe(404);

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

    it("view risk diff: POST renders the real @aart/governance semantic risk diff between two versions (reconciliation ledger item 13)", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "1.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }] } }));
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "2.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }, { id: "s2", uses: "command.run" }] } }));

      const res = await fetch(`${baseUrl}/workflows/wf-diff/risk-diff`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "fromVersion=1.0.0&toVersion=2.0.0",
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("command.run");
      // command.run's real manifest capability ("command") - only present if
      // this route genuinely routes through the real capability-closure-based
      // semanticRiskDiff, not a structural uses-string comparison.
      expect(text).toContain("New capabilities");
      expect(text).toContain("command");
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
      // AMENDMENTS.md A47: update-run-output now routes through
      // @aart/evidence's real `updateRunOutput` (server-side,
      // `packages/server/src/http/server.ts`'s new
      // `/corrections/:key/update-run-output` endpoint) instead of this
      // package's former local mirror — the real one patches the target
      // STEP's own trace.outputs (spec §23.3's `(runId, stepId, fieldPath)`
      // scoping, `fieldPath` a dot-path INTO that step's trace), not
      // `RunRecord.outputs` directly the way the old mirror's "outputs."
      // special case did; a correction therefore needs a matching trace
      // entry for `stepId` to exist, same as any other real caller.
      await fixture.store.runs.put(
        makeRun({ runId: "run-out", workflowId: "wf-out", workflowVersion: "1.0.0", trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { total: 1 }, startedAt: "t" }] }),
      );
      const correction = makeCorrection({ runId: "run-out", stepId: "step1", fieldPath: "outputs.total", corrected: 42 });
      await fixture.store.corrections.put(correction);
      const key = encodeURIComponent("run-out:step1:outputs.total");

      const updateRes = await fetch(`${baseUrl}/corrections/${key}/update-run-output`, { method: "POST", redirect: "manual" });
      expect(updateRes.status).toBe(303);
      const updatedRun = await fixture.store.runs.get("run-out");
      expect(updatedRun?.trace[0]?.outputs).toEqual({ total: 42 });
      expect(updatedRun?.trace[0]?.postHocCorrected).toBe(true);

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
      // AMENDMENTS.md A47: run-eval now routes through
      // `packages/server/src/evals.ts`'s `runEvalSuiteForWorkflow`, which
      // verifies the target workflow version actually exists (matching
      // `packages/mcp/src/handlers/evals.ts`'s real `runEvalHandler`) — the
      // pre-A47 dashboard-local mirror never checked, silently persisting
      // an EvalRun against an unvalidated workflowId/Version.
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));

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
