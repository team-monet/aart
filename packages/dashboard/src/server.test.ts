// Integration tests: a real node:http server (via startDashboard), driven
// with real fetch() calls. Unit-level correctness of what used to live in
// views/*.test.ts now lives against the real implementations it delegates
// to — packages/dashboard/src/api-client.test.ts (every ApiClient method,
// both the store-backed fake and a real @aart/server instance over real
// HTTP) and stub-deps.test.ts (the remaining local DashboardDeps mirrors:
// redact, resumeApproval, report renderers, etc.) — this file's job is
// proving the ROUTER WIRING itself (right path -> right handler -> right
// status/body), end to end, for a representative slice of every v1/v2/v3
// route, using the real stub deps + a real fs-backed store
// (createFakeApiClient reading the same store, standing in for a live S2
// process this worktree doesn't have).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeApiClient } from "./api-client.js";
import { startDashboard, type DashboardHandle } from "./server.js";
import { createTestFixture, makeCorrection, makeEnvironment, makeRun, makeWorkflow, type TestFixture } from "./test-support/fixtures.js";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Sends `rawPath` as the literal HTTP request-target — unlike fetch()/the
 * WHATWG URL constructor (which normalizes ".", ".."/AND their single
 * percent-encoded forms "%2e"/"%2E" out of a path before the request is
 * even built — verified empirically, not assumed), node:http's own client
 * performs no such normalization: whatever string is given as `path` is
 * written to the wire byte-for-byte. That's the shape a non-browser HTTP
 * client can send, and the shape server.ts's own static handler must
 * defend against on its own — it can't rely on every caller being a
 * spec-compliant URL-normalizing client. */
function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("dashboard HTTP server — JSON REST API & SPA fallback routing", () => {
  let fixture: TestFixture;
  let handle: DashboardHandle;
  let baseUrl: string;
  // The REAL vite build output directory (packages/dashboard/frontend's own
  // vite.config.ts: `build.outDir: '../dist/frontend'`, i.e.
  // packages/dashboard/dist/frontend — resolved here from __dirname
  // (packages/dashboard/src at test time) the same way getFrontendDir()'s
  // own candidate list resolves it from packages/dashboard/dist at
  // production runtime: "../dist/frontend" from either src/ or dist/
  // lands on the identical real directory. The PRIOR version of this setup
  // fabricated "frontend/dist" (packages/dashboard/frontend/dist) instead —
  // a directory vite never writes to — so it was never actually exercising
  // getFrontendDir()'s real resolution path, just one of its dead
  // candidates (server.ts's getFrontendDir() has a couple of those; see its
  // own comment).
  let tempFrontendDir: string;
  let createdTempDir = false;
  // If a real `pnpm run build` already populated tempFrontendDir before this
  // suite ran (e.g. CI's Build step runs before Test), back it up and
  // restore it afterward instead of deleting it — this suite deliberately
  // targets the SAME directory production resolves to, so it must not
  // destroy real build output sitting in the working tree.
  let backupDir: string | undefined;

  beforeAll(async () => {
    tempFrontendDir = path.resolve(__dirname, "../dist/frontend");
    if (existsSync(tempFrontendDir)) {
      backupDir = await fs.mkdtemp(path.join(tmpdir(), "aart-dashboard-frontend-backup-"));
      await fs.cp(tempFrontendDir, backupDir, { recursive: true });
      await fs.rm(tempFrontendDir, { recursive: true, force: true });
    }
    try {
      await fs.mkdir(tempFrontendDir, { recursive: true });
      await fs.writeFile(path.join(tempFrontendDir, "index.html"), "<html><body>Dummy App</body></html>");
      createdTempDir = true;
    } catch (err) {
      console.warn("Could not create temp frontend directory, SPA fallback might skip", err);
    }
  });

  afterAll(async () => {
    if (createdTempDir) {
      try {
        await fs.rm(tempFrontendDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    if (backupDir) {
      await fs.mkdir(tempFrontendDir, { recursive: true });
      await fs.cp(backupDir, tempFrontendDir, { recursive: true });
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  });

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

  it("GET / serves the SPA frontend index.html fallback with status 200", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Dummy App");
  });

  describe("static file serving — path traversal is never served, always falls back to the SPA shell", () => {
    it("a request whose decoded path resolves outside the frontend build directory gets the SPA shell, never the outside file", async () => {
      // A canary file ONE level above tempFrontendDir (i.e. inside
      // packages/dashboard/dist/ itself, sibling to frontend/) — reachable
      // only if the traversal defense fails. "%2e%2e" (not raw "..") is
      // deliberately used here: plain ".." never survives as far as
      // server.ts's own code — new URL()'s own WHATWG-spec dot-segment
      // removal already collapses BOTH literal ".." and singly-percent-
      // encoded "%2e"/"%2E" before `url.pathname` is even read (verified
      // directly against this Node version, not assumed from the spec
      // text) — so a plain "../" test would pass whether or not
      // server.ts's own resolve-then-verify-prefix logic does anything at
      // all, which would make it a vacuous regression test.
      const outsideDir = path.dirname(tempFrontendDir);
      const canaryPath = path.join(outsideDir, "traversal-canary.txt");
      await fs.writeFile(canaryPath, "SHOULD-NEVER-BE-SERVED");
      try {
        const res = await rawGet(handle.port, "/%2e%2e/traversal-canary.txt");
        expect(res.status).toBe(200);
        expect(res.body).not.toContain("SHOULD-NEVER-BE-SERVED");
        expect(res.body).toContain("Dummy App");
      } finally {
        await fs.rm(canaryPath, { force: true });
      }
    });

    it("a decoded path containing a literal backslash is never treated as a separator (path.posix, not the OS-generic path module)", async () => {
      // "%5c" (percent-encoded backslash) survives new URL()'s own
      // normalization untouched (verified directly — unlike "%2e", it is
      // not one of the strings the WHATWG path state recognizes), so
      // server.ts's own decode step is genuinely the first thing that ever
      // turns it into a real "\" character. On a Windows host, the
      // OS-generic `path` module (path.normalize/path.join) treats "\" as
      // a separator and WOULD resolve a decoded "\.." upward past the
      // intended root — confirmed directly against path.win32.normalize
      // during this fix's own investigation. This suite runs on POSIX CI,
      // where path.posix and the OS-generic module already coincide, so
      // this test cannot observe that specific platform divergence — what
      // it DOES lock in is that a decoded backslash is inert here (treated
      // as an ordinary filename character, not a separator), which is the
      // necessary condition for path.posix.normalize to be the right
      // choice at all.
      const res = await rawGet(handle.port, "/assets/%5c..%5csecret");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Dummy App");
    });
  });

  it("GET /health reports dashboard liveness in JSON", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  describe("v1 read-only API", () => {
    it("GET /api/runs lists runs; GET /api/runs/:id returns run JSON & report HTML", async () => {
      await fixture.store.runs.put(makeRun({ runId: "run-1", status: "completed" }));

      const list = await fetch(`${baseUrl}/api/runs`);
      expect(list.status).toBe(200);
      const runs = await list.json() as any[];
      expect(runs).toHaveLength(1);
      expect(runs[0].runId).toBe("run-1");

      const detail = await fetch(`${baseUrl}/api/runs/run-1`);
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as any;
      expect(detailJson.run.runId).toBe("run-1");
      expect(detailJson.reportHtml).toContain('class="run-report"'); // S6 report-renderer seam output

      const missing = await fetch(`${baseUrl}/api/runs/does-not-exist`);
      expect(missing.status).toBe(404);
    });

    it("GET /api/workflows lists ids; GET /api/workflows/:id returns workflow details", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "1.0.0" }));
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-1", version: "2.0.0" }));
      await fixture.store.runs.put(makeRun({ runId: "run-for-wf-1", workflowId: "wf-1", workflowVersion: "1.0.0" }));

      const list = await fetch(`${baseUrl}/api/workflows`);
      expect(list.status).toBe(200);
      expect(await list.json()).toContain("wf-1");

      const detail = await fetch(`${baseUrl}/api/workflows/wf-1`);
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as any;
      expect(detailJson.workflow.version).toBe("2.0.0"); // latest version by default
      expect(detailJson.versions).toEqual(["1.0.0", "2.0.0"]); // version history
      expect(detailJson.recentRuns).toHaveLength(1);
      expect(detailJson.recentRuns[0].runId).toBe("run-for-wf-1");

      const specificVersion = await fetch(`${baseUrl}/api/workflows/wf-1?version=1.0.0`);
      expect(specificVersion.status).toBe(200);
      const specificJson = await specificVersion.json() as any;
      expect(specificJson.workflow.version).toBe("1.0.0");

      const missing = await fetch(`${baseUrl}/api/workflows/no-such-workflow`);
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
    // still return it, because the route no longer reads `store` at all.
    it("workflow detail reads through `api`, not the dashboard's own local `store` — a misconfigured/empty local store no longer breaks the JSON response as long as the real data is reachable via the API boundary", async () => {
      const real = await createTestFixture();
      try {
        await real.store.workflows.put(makeWorkflow({ id: "wf-divergent", version: "1.0.0" }));

        await handle.close();
        handle = await startDashboard({ store: fixture.store, api: createFakeApiClient(real.store), deps: fixture.deps, clock: fixture.clock, port: 0 });
        baseUrl = `http://127.0.0.1:${handle.port}`;

        expect(await fixture.store.workflows.getLatest("wf-divergent")).toBeUndefined(); // this test's own dashboard-local store genuinely has no such workflow

        const res = await fetch(`${baseUrl}/api/workflows/wf-divergent`);
        expect(res.status).toBe(200);
        const detail = (await res.json()) as { workflow: { version: string } };
        expect(detail.workflow.version).toBe("1.0.0");
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

        const approvalsJson = (await (await fetch(`${baseUrl}/api/approvals`)).json()) as Array<{ title: string }>;
        expect(approvalsJson.some((a) => a.title === "Ship?")).toBe(true);
        const correctionsJson = (await (await fetch(`${baseUrl}/api/corrections`)).json()) as Array<{ runId: string }>;
        expect(correctionsJson.some((c) => c.runId === "run-div")).toBe(true);
        const evalsJson = (await (await fetch(`${baseUrl}/api/evals`)).json()) as { suites: Array<{ name: string }> };
        expect(evalsJson.suites.some((s) => s.name === "S")).toBe(true);

        // Writes: trigger a run, decide an approval, record a correction —
        // every effect must land in real.store, and fixture.store must stay
        // untouched throughout.
        const triggerRes = await fetch(`${baseUrl}/api/runs/trigger`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowId: "wf-div2", workflowVersion: "1.0.0", inputs: {} }),
        });
        expect(triggerRes.status).toBe(200);
        expect(await real.store.runs.list({ workflowId: "wf-div2" })).toHaveLength(1);
        expect(await fixture.store.runs.list({ workflowId: "wf-div2" })).toHaveLength(0);

        const decideRes = await fetch(`${baseUrl}/api/approvals/at-div/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "approved", reviewer: "alice", trustMode: "governed" }),
        });
        expect(decideRes.status).toBe(200);
        expect((await real.store.approvals.get("at-div"))?.status).toBe("approved");
        expect(await fixture.store.approvals.get("at-div")).toBeUndefined();

        const correctRes = await fetch(`${baseUrl}/api/corrections`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: "run-div", stepId: "step1", fieldPath: "outputs.y", observed: 1, corrected: 2, reason: "r", reviewer: "alice" }),
        });
        expect(correctRes.status).toBe(200);
        expect(await real.store.corrections.list({ runId: "run-div", stepId: "step1" })).toHaveLength(2); // the fixture-seeded one + this new one
        expect(await fixture.store.corrections.list()).toEqual([]);
      } finally {
        await real.cleanup();
      }
    });

    it("GET /api/blocks lists block manifests; GET /api/blocks/:id returns single block manifest", async () => {
      const blocksRes = await fetch(`${baseUrl}/api/blocks`);
      expect(blocksRes.status).toBe(200);
      const blocks = await blocksRes.json() as any[];
      expect(blocks.some(b => b.id === "http.request")).toBe(true);

      const detailRes = await fetch(`${baseUrl}/api/blocks/http.request`);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as any;
      expect(detail.id).toBe("http.request");
      expect(detail.inputSchema).toBeDefined();

      const missing = await fetch(`${baseUrl}/api/blocks/no.such.block`);
      expect(missing.status).toBe(404);
    });

    it("GET /api/artifacts aggregates artifacts across runs in JSON", async () => {
      await fixture.store.runs.put(
        makeRun({ runId: "run-art", artifacts: [{ id: "a1", runId: "run-art", name: "out.json", kind: "json_output", mime: "application/json", path: "a1.json", bytes: 10, createdAt: "t" }] }),
      );
      const res = await fetch(`${baseUrl}/api/artifacts`);
      expect(res.status).toBe(200);
      const runs = await res.json() as any[];
      expect(runs[0].artifacts[0].name).toBe("out.json");
    });

    it("run-bearing responses (/api/runs, /api/runs/:id, /api/artifacts) route through deps.redact before serialization — the old surface's 'values NEVER shown' invariant", async () => {
      // A test-local RedactFn — not the identity stub `fixture.deps.redact`
      // defaults to (that would make this test pass vacuously), and not
      // @aart/governance's real redactRecord either (its own value-scan
      // algorithm is already covered by packages/governance/src/
      // redact.test.ts/redact-adversarial.test.ts — this test's only job is
      // proving THESE THREE ROUTES actually call deps.redact at all, i.e.
      // the chokepoint wiring). Redacts a fixed marker wherever it appears,
      // structurally mirroring redactRecord's own contract (value-scan
      // across the whole record, never a field-name allowlist) but
      // decoupled from `resolvedSecretRefs` so the test doesn't depend on
      // what server.ts happens to pass as the second argument.
      const SECRET = "sk-test-planted-secret-9f2a";
      const KNOWN_MARKER = "keep-this-value-intact";
      function redactMarker(record: unknown): unknown {
        if (typeof record === "string") return record.split(SECRET).join("[TEST-REDACTED]");
        if (Array.isArray(record)) return record.map(redactMarker);
        if (record && typeof record === "object") {
          return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, redactMarker(v)]));
        }
        return record;
      }

      await handle.close();
      const api = createFakeApiClient(fixture.store);
      const deps = { ...fixture.deps, redact: (record: unknown, _resolvedSecretRefs: ReadonlySet<string>) => redactMarker(record) };
      handle = await startDashboard({ store: fixture.store, api, deps, clock: fixture.clock, port: 0 });
      baseUrl = `http://127.0.0.1:${handle.port}`;

      await fixture.store.runs.put(makeRun({ runId: "run-redact", outputs: { token: SECRET, note: KNOWN_MARKER } }));

      const detail = (await (await fetch(`${baseUrl}/api/runs/run-redact`)).json()) as { run: { outputs: Record<string, unknown> } };
      expect(JSON.stringify(detail.run)).not.toContain(SECRET);
      expect(detail.run.outputs["note"]).toBe(KNOWN_MARKER);

      const list = (await (await fetch(`${baseUrl}/api/runs`)).json()) as Array<{ outputs: Record<string, unknown> }>;
      expect(JSON.stringify(list)).not.toContain(SECRET);
      expect(list[0]?.outputs["note"]).toBe(KNOWN_MARKER);

      const artifacts = (await (await fetch(`${baseUrl}/api/artifacts`)).json()) as Array<{ outputs: Record<string, unknown> }>;
      expect(JSON.stringify(artifacts)).not.toContain(SECRET);
      expect(artifacts[0]?.outputs["note"]).toBe(KNOWN_MARKER);
    });
  });

  describe("v2 writable API", () => {
    it("trigger workflow: POST /api/runs/trigger triggers a run and returns JSON run record", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-trig", version: "1.0.0" }));

      const res = await fetch(`${baseUrl}/api/runs/trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId: "wf-trig",
          workflowVersion: "1.0.0",
          inputs: { x: 1 }
        })
      });
      expect(res.status).toBe(200);
      const run = await res.json() as any;
      expect(run.runId).toBeDefined();

      const runs = await fixture.store.runs.list({ workflowId: "wf-trig" });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("pending");
    });

    it("approve/deprecate: POST /api/workflows/:id/approve updates approval status", async () => {
      await fixture.store.workflows.put(
        makeWorkflow({ id: "wf-appr", version: "1.0.0", approval: "draft", gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } }),
      );

      const res = await fetch(`${baseUrl}/api/workflows/wf-appr/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          action: "approve",
          trustMode: "governed"
        })
      });

      expect(res.status).toBe(200);
      expect((await res.json())).toEqual({ success: true });
      expect((await fixture.store.workflows.get("wf-appr", "1.0.0"))?.approval).toBe("approved");
    });

    it("promote: POST /api/workflows/:id/promote promotes workflow", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-prom", version: "1.0.0", approval: "approved" }));
      await fixture.store.environments.put(makeEnvironment({ id: "env-prom", config: { trustMode: "dev" } }));

      const res = await fetch(`${baseUrl}/api/workflows/wf-prom/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          environmentId: "env-prom"
        })
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(await fixture.store.deployments.list({ workflowId: "wf-prom" })).toHaveLength(1);
    });

    it("view risk diff: POST /api/workflows/:id/risk-diff returns semantic risk diff", async () => {
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "1.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }] } }));
      await fixture.store.workflows.put(makeWorkflow({ id: "wf-diff", version: "2.0.0", execution: { type: "workflow", steps: [{ id: "s1", uses: "http.request" }, { id: "s2", uses: "command.run" }] } }));

      const res = await fetch(`${baseUrl}/api/workflows/wf-diff/risk-diff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromVersion: "1.0.0",
          toVersion: "2.0.0"
        })
      });

      expect(res.status).toBe(200);
      const diff = await res.json() as any;
      expect(diff.newCapabilities).toContain("command");
    });

    it("inspect waiting runs: GET /api/waiting-runs returns waits and age", async () => {
      await fixture.store.waits.put("run-w", "step1", { type: "manual", schemaVersion: 1 }, fixture.clock.nowIso());
      const res = await fetch(`${baseUrl}/api/waiting-runs`);
      expect(res.status).toBe(200);
      const payload = await res.json() as any;
      expect(payload.waitingRuns[0].runId).toBe("run-w");
    });

    it("approve human tasks: POST /api/approvals/:id/decision updates task status", async () => {
      await fixture.store.runs.put(makeRun({ runId: "run-appr", status: "waiting", waits: [{ type: "approval", taskId: "task-1", schemaVersion: 1 }] }));
      await fixture.store.waits.put("run-appr", "step1", { type: "approval", taskId: "task-1", schemaVersion: 1 }, fixture.clock.nowIso());
      await fixture.store.approvals.put({ id: "task-1", runId: "run-appr", stepId: "step1", title: "Ship?", description: "d", status: "pending", createdAt: fixture.clock.nowIso() });

      const res = await fetch(`${baseUrl}/api/approvals/task-1/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "approved",
          reviewer: "alice",
          trustMode: "governed"
        })
      });
      expect(res.status).toBe(200);
      expect((await fixture.store.approvals.get("task-1"))?.status).toBe("approved");
      expect((await fixture.store.runs.get("run-appr"))?.status).toBe("running");
    });

    it("record correction: POST /api/corrections persists Correction JSON", async () => {
      const res = await fetch(`${baseUrl}/api/corrections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-1",
          stepId: "step1",
          fieldPath: "outputs.total",
          observed: 1,
          corrected: 2,
          reason: "off by one",
          reviewer: "alice"
        })
      });
      expect(res.status).toBe(200);
      expect(await fixture.store.corrections.list({ runId: "run-1" })).toHaveLength(1);
    });

    it("correction outcomes: update-run-output / create-eval-example / create-issue all reachable", async () => {
      await fixture.store.runs.put(
        makeRun({ runId: "run-out", workflowId: "wf-out", workflowVersion: "1.0.0", trace: [{ seq: 0, stepId: "step1", block: "http.get", status: "completed", inputs: {}, outputs: { total: 1 }, startedAt: "t" }] }),
      );
      const correction = makeCorrection({ runId: "run-out", stepId: "step1", fieldPath: "outputs.total", corrected: 42 });
      await fixture.store.corrections.put(correction);
      const key = encodeURIComponent("run-out:step1:outputs.total");

      const updateRes = await fetch(`${baseUrl}/api/corrections/${key}/update-run-output`, { method: "POST" });
      expect(updateRes.status).toBe(200);
      const updatedRun = await fixture.store.runs.get("run-out");
      expect(updatedRun?.trace[0]?.outputs).toEqual({ total: 42 });

      const evalRes = await fetch(`${baseUrl}/api/corrections/${key}/create-eval-example`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suiteId: "suite-1" })
      });
      expect(evalRes.status).toBe(200);
      expect(await fixture.store.evals.listExamples("suite-1")).toHaveLength(1);

      const issueRes = await fetch(`${baseUrl}/api/corrections/${key}/create-issue`, { method: "POST" });
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

      const createRes = await fetch(`${baseUrl}/api/evals/suites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "My Suite", scorerKind: "exact_match" }),
      });
      expect(createRes.status).toBe(200);

      const suites = await fixture.store.evals.listSuites();
      expect(suites).toHaveLength(1);
      await fixture.store.evals.putExample({ id: "ex1", suiteId: suites[0]!.id, input: 1, expected: 1 });
      // putExample alone doesn't attach to suite.examples (separate collections, per AartStore's
      // EvalStore shape) — refresh the suite the way runEvalSuiteForWorkflow reads it (store.evals.getSuite/listExamples).
      const refreshedSuite = { ...suites[0]!, examples: await fixture.store.evals.listExamples(suites[0]!.id) };
      await fixture.store.evals.putSuite(refreshedSuite);

      const runRes = await fetch(`${baseUrl}/api/evals/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suiteId: refreshedSuite.id, workflowId: "wf-1", workflowVersion: "1.0.0" }),
      });
      expect(runRes.status).toBe(200);
      expect(await fixture.store.evals.listRuns({ suiteId: refreshedSuite.id })).toHaveLength(1);

      const evalsJson = (await (await fetch(`${baseUrl}/api/evals`)).json()) as { suites: Array<{ name: string }> };
      expect(evalsJson.suites.some((s) => s.name === "My Suite")).toBe(true);
    });
  });

  describe("v3 production additions", () => {
    it("GET /api/environments, /api/deployments, /api/trigger-configs return the corresponding data in JSON", async () => {
      await fixture.store.environments.put(makeEnvironment({ id: "env-1", name: "staging" }));
      await fixture.store.deployments.put({ id: "dep-1", workflowId: "wf-1", workflowVersion: "1.0.0", environmentId: "env-1", triggerConfig: { cron: "0 * * * *" }, createdAt: "t" });

      const envs = await (await fetch(`${baseUrl}/api/environments`)).json() as any[];
      expect(envs[0].name).toBe("staging");

      const deps = await (await fetch(`${baseUrl}/api/deployments`)).json() as any[];
      expect(deps[0].id).toBe("dep-1");

      const trig = await (await fetch(`${baseUrl}/api/trigger-configs`)).json() as any[];
      expect(trig[0].triggerConfig.cron).toBe("0 * * * *");
    });

    it("GET /api/secrets returns secrets status without actual values", async () => {
      await fixture.store.environments.put(makeEnvironment({ id: "env-s", name: "prod", secretSource: { GITHUB_TOKEN: { path: "/vault/super-secret-value" } } }));
      const envs = await (await fetch(`${baseUrl}/api/secrets`)).json() as any[];
      expect(envs[0].secretSource.GITHUB_TOKEN.status).toBe("bound");
      expect(JSON.stringify(envs)).not.toContain("super-secret-value");
    });

    it("GET /api/worker-health polls each configured worker and reports an unreachable one distinctly", async () => {
      await handle.close();
      const api = createFakeApiClient(fixture.store, { workerHealth: new Map([["http://worker-ok:8787", { status: "ok", claimedRuns: 1, uptime: 5, version: "0.1.0" }]]) });
      handle = await startDashboard({ store: fixture.store, api, deps: fixture.deps, clock: fixture.clock, port: 0, workerUrls: ["http://worker-ok:8787", "http://worker-down:8787"] });
      baseUrl = `http://127.0.0.1:${handle.port}`;

      const workers = (await (await fetch(`${baseUrl}/api/worker-health`)).json()) as Array<{ url: string; health: { status?: string; error?: string } }>;
      const ok = workers.find((w) => w.url === "http://worker-ok:8787");
      const down = workers.find((w) => w.url === "http://worker-down:8787");
      expect(ok?.health.status).toBe("ok");
      expect(down?.health.error).toBeDefined();
    });

    describe("flagged runs — clear action", () => {
      it("GET /api/flagged-runs lists flagged runs; POST .../clear clears flag", async () => {
        await fixture.store.runs.put(makeRun({ runId: "run-flag", status: "failed", flag: { kind: "poison", flaggedAt: fixture.clock.nowIso() } }));

        const list = await fetch(`${baseUrl}/api/flagged-runs`);
        expect(list.status).toBe(200);
        const runs = await list.json() as any[];
        expect(runs[0].runId).toBe("run-flag");

        const clearRes = await fetch(`${baseUrl}/api/flagged-runs/run-flag/clear`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "clearedBy=alice"
        });
        expect(clearRes.status).toBe(200);
        const cleared = await fixture.store.runs.get("run-flag");
        expect(cleared?.flag?.clearedBy).toBe("alice");
      });

      it("POST /api/flagged-runs/:runId/clear on an unflagged run returns 409, not a silent success", async () => {
        await fixture.store.runs.put(makeRun({ runId: "run-noflag", status: "failed" }));
        const res = await fetch(`${baseUrl}/api/flagged-runs/run-noflag/clear`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(409);
      });
    });
  });
});
