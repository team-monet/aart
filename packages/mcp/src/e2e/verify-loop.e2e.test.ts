// Verify-loop E2E (S9 plan §4's unattempted item, S10 completion). Exercises
// the REAL aart_verify tool (handlers/execution.ts's verifyHandler) — spec
// §32.6's "agent's easiest success path: one call, url + optional expect,
// evidence report back" — end to end against a real local HTTP server, a
// real headless browser (Playwright, via @aart/blocks-core's real
// browser.goto/web.read/browser.screenshot blocks), and real evidence
// rendering (@aart/evidence's real renderModelFacing, via
// createRealAartContext — the same real composition review-cycle/
// item-review/redaction-adversarial's own E2E tests use, not stubs).
//
// "Loop" is this file's own literal proof of AGENTS.md's documented
// authoring loop (packages/mcp/src/init-agent.ts's generated instructions:
// "Run... For a quick one-shot check instead of a saved workflow, use
// aart_verify... Report... If it failed, revise the draft... and loop"):
// call aart_verify, observe a genuine FAILURE with real evidence (not a
// rubber stamp), fix the input, call aart_verify AGAIN, observe a genuine
// PASS — the same real synthetic workflow (registered once, version keyed
// only on whether `expect` is given, not its value) reused across both
// calls, exactly as spec §32.6 intends.
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { createRealAartContext, verifyHandler, type AartContext } from "@aart/mcp";

let server: Server;
let baseUrl: string;
// Deliberately mutable, read by the request handler on every request — lets
// the SAME running server model a page's content changing between two
// aart_verify calls (e.g. "the deployment wasn't live yet" -> "now it is"),
// the realistic real-world shape of the loop's "revise, then re-verify"
// step, without needing to spin up a second server.
let pageText = "Under construction.";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body><h1 id="target">${pageText}</h1></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a real AddressInfo from server.listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeContext(): Promise<AartContext> {
  const root = await mkdtemp(join(tmpdir(), "aart-e2e-verify-loop-"));
  roots.push(root);
  // trustMode "dev" — this test isn't exercising governance/approval, only
  // aart_verify's own real execution + evidence path; createRealAartContext
  // still builds the real 56-block catalog and real Engine regardless.
  return createRealAartContext({ root, trustMode: "dev" });
}

describe("verify-loop E2E — real aart_verify tool, real browser, real evidence (spec §32.6)", () => {
  it(
    "PASS path: aart_verify against a real local page whose content genuinely matches expect returns ok:true, headline 'passed', and a real screenshot artifact",
    async () => {
      pageText = "Deployment successful.";
      const ctx = await makeContext();

      const result = await verifyHandler(ctx, { url: baseUrl, expect: "Deployment successful" });

      expect(result.ok).toBe(true);
      const report = result["report"] as { headline: string; artifactRefs: Array<{ id: string; kind: string; uri: string }> };
      expect(report.headline).toBe("passed");

      // Real evidence, not just a status string: a real browser.screenshot
      // step ran and its artifact is genuinely referenced in the report.
      const screenshotRef = report.artifactRefs.find((a) => a.kind === "screenshot");
      expect(screenshotRef).toBeDefined();
      const bytes = await ctx.store.artifacts.getBytes(screenshotRef!.id);
      expect(bytes).toBeDefined();
      expect(bytes!.byteLength).toBeGreaterThan(0);
      // A real PNG file signature (\x89PNG\r\n\x1a\n) — not just "some bytes exist", genuinely a captured image.
      expect(Array.from(bytes!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    },
    30_000,
  );

  it(
    "FAIL path: aart_verify against the SAME real page with an expect string that genuinely isn't present returns ok:false, headline 'failed', with a real failure entry naming the assert step — not a rubber stamp",
    async () => {
      pageText = "Deployment successful.";
      const ctx = await makeContext();

      const result = await verifyHandler(ctx, { url: baseUrl, expect: "Deployment FAILED — rollback required" });

      expect(result.ok).toBe(false);
      const report = result["report"] as { headline: string; failures: Array<{ stepId: string; block: string; error: string }> };
      expect(report.headline).toBe("failed");
      expect(report.failures.length).toBeGreaterThan(0);
      expect(report.failures[0]).toMatchObject({ stepId: "assert", block: "assert.contains" });
    },
    30_000,
  );

  it(
    "THE LOOP: a failed verify (page not yet in the expected state), the underlying state changes, verify called again — genuinely passes the second time, same registered workflow reused both calls",
    async () => {
      const ctx = await makeContext();

      // 1. Draft/deploy state: not yet correct.
      pageText = "Under construction.";
      const firstAttempt = await verifyHandler(ctx, { url: baseUrl, expect: "Deployment successful" });
      expect(firstAttempt.ok).toBe(false);
      const firstReport = firstAttempt["report"] as { headline: string };
      expect(firstReport.headline).toBe("failed");
      const firstRunId = firstAttempt["runId"];

      // 2. "Revise" — the real-world action a real deployment/authoring
      // loop would take between the failed check and the next one (here:
      // the page's content changes, modeling the underlying thing getting
      // fixed).
      pageText = "Deployment successful.";

      // 3. Re-verify — a SEPARATE aart_verify call (a fresh run, own
      // runId), through the exact same tool, same registered synthetic
      // workflow (version is keyed only on whether `expect` is given, per
      // execution.ts's ensureVerifyWorkflow — reused across both calls,
      // not re-registered).
      const secondAttempt = await verifyHandler(ctx, { url: baseUrl, expect: "Deployment successful" });
      expect(secondAttempt.ok).toBe(true);
      const secondReport = secondAttempt["report"] as { headline: string };
      expect(secondReport.headline).toBe("passed");
      expect(secondAttempt["runId"]).not.toBe(firstRunId); // two genuinely distinct runs, not one run's status flipping in place

      // Both runs are independently, durably on record — the loop's
      // history isn't lost the moment it succeeds.
      const firstRun = await ctx.store.runs.get(firstRunId as string);
      const secondRun = await ctx.store.runs.get(secondAttempt["runId"] as string);
      expect(firstRun?.status).toBe("failed");
      expect(secondRun?.status).toBe("completed");
      expect(firstRun?.workflowId).toBe(secondRun?.workflowId);
      expect(firstRun?.workflowVersion).toBe(secondRun?.workflowVersion);
    },
    45_000,
  );
});
