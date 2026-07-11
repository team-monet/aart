#!/usr/bin/env node
// The familiarity-evals CI gate (S9 integration, reconciliation ledger
// item 14: "wire familiarity-evals into CI with fake-model adapter").
// Matches this repo's established scripts/smoke/*.mjs / redaction-lint-cli
// convention: a standalone entry point, non-zero exit on failure, meant to
// be wired into .github/workflows/ci.yml as its own step.
//
// Uses model-runner.ts's own already-built createFakeModelRunner (S6's
// DoD explicitly built this: "a model-runner interface with a fake-model
// adapter... so this package is fully offline-testable") — this session
// (S9) did NOT need to build the fake-model mechanism, only wire it up
// end-to-end with the REAL validate/run-success checks (real-checks.ts)
// and a real CI entry point.
//
// HONEST DISCLOSURE (same "Risk 6"-shaped gap this whole build already
// discloses for its other LLM-dependent E2E flows): spec §32.4 says
// familiarity-eval baselines should run "against real target models,
// including a genuinely weak one." No LLM provider API key is available
// in the environment this was built in (verified: none of
// ANTHROPIC_API_KEY/OPENAI_API_KEY/GOOGLE_API_KEY/GEMINI_API_KEY are
// set). This gate therefore runs against the FAKE model only — it proves
// the HARNESS (real validation, real run-success, deterministic scoring,
// the whole pipeline) is wired correctly and stays a genuinely useful
// regression gate (a real bug in aart_validate or the block catalog
// WOULD show up here), but it does NOT satisfy §32.4's full intent of
// measuring a real model's zero-shot behavior. A real-model baseline run
// (at least one strong + one deliberately weak model, per spec) is
// necessary, documented follow-up once a provider key is available -
// not attempted here as a guess.
import { closeAllBrowserSessions } from "@aart/blocks-core";
import { createFsStore } from "@aart/store";
import { AUTHORING_TASK_CATALOG, createFakeModelRunner, runFamiliarityEvalSuite, type ScriptedResponse } from "./index.js";
import { createRealRunSuccessFn, createRealValidateFn } from "./real-checks.js";

// One well-formed, VALID candidate Workflow per task, referencing exactly
// task.expectedBlocks - scripted to converge on round 0 (first-draft
// valid) against the REAL validateWorkflow, so a real regression in
// aart_validate/the block catalog/this package's own scoring surfaces as
// a gate failure here rather than silently passing. Deliberately does NOT
// script a "weak model" struggling-then-correcting scenario for any task
// - simulating model quality with a fake model would just be this script
// picking arbitrary numbers, adding no real signal; that measurement
// needs an actual model (see the module doc comment above).
function workflow(id: string, steps: Array<{ id: string; uses: string; with?: Record<string, unknown> }>) {
  return {
    id,
    name: id,
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow" as const, steps },
    approval: "approved" as const,
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } as const,
  };
}

const SCRIPT: Record<string, ScriptedResponse> = {
  "verify-page-renders": {
    rawOutput: "scripted",
    workflow: workflow("verify-page-renders", [
      { id: "s1", uses: "browser.goto", with: { url: "https://example.com" } },
      { id: "s2", uses: "web.read", with: {} },
      { id: "s3", uses: "assert.contains", with: { actual: "{{ steps.s2.outputs.text }}", expected: "Example Domain" } },
    ]),
  },
  "check-api-health": {
    rawOutput: "scripted",
    workflow: workflow("check-api-health", [{ id: "s1", uses: "http.health_check", with: { url: "https://example.com/health" } }]),
  },
  "download-and-parse-csv": {
    rawOutput: "scripted",
    workflow: workflow("download-and-parse-csv", [
      // https://example.com (not /data.csv, which 404s - IANA's reserved
      // example.com has no such path) - http.download doesn't care about
      // content-type, only that the request succeeds; data.parse below is
      // fed a literal CSV string directly, not this step's actual bytes,
      // so what gets downloaded doesn't need to genuinely BE a CSV for
      // this run-success check's purpose (proving both blocks dispatch
      // and complete, not validating real-world CSV content).
      { id: "s1", uses: "http.download", with: { url: "https://example.com" } },
      { id: "s2", uses: "data.parse", with: { input: "a,b\n1,2", format: "csv" } },
    ]),
  },
  "fill-web-form-and-screenshot": {
    rawOutput: "scripted",
    workflow: workflow("fill-web-form-and-screenshot", [
      // browser.fill needs an actual page with a matching element first -
      // a self-contained data: URL (a bare <input id="email">) avoids
      // depending on any external site's exact markup staying stable.
      { id: "s0", uses: "browser.goto", with: { url: "data:text/html,<input id=\"email\">" } },
      { id: "s1", uses: "browser.fill", with: { selector: "#email", value: "test@example.com" } },
      { id: "s2", uses: "browser.screenshot", with: {} },
    ]),
  },
  "watch-webhook-and-resume": {
    rawOutput: "scripted",
    workflow: workflow("watch-webhook-and-resume", [{ id: "s1", uses: "wait.for_webhook", with: { event: "example.event", correlationId: "corr-1" } }]),
  },
  "wait-for-human-approval": {
    rawOutput: "scripted",
    workflow: workflow("wait-for-human-approval", [{ id: "s1", uses: "human.approval", with: { title: "Approve extracted data", description: "Review before continuing." } }]),
  },
  "call-llm-with-schema": {
    rawOutput: "scripted",
    workflow: workflow("call-llm-with-schema", [
      { id: "s1", uses: "llm.call", with: { model: "anthropic/claude-sonnet-5", prompt: "Classify this text.", input: "some text", outputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } },
    ]),
  },
  "run-eval-before-promotion": {
    rawOutput: "scripted",
    workflow: workflow("run-eval-before-promotion", [
      {
        id: "s1",
        uses: "eval.run",
        with: {
          suite: { id: "suite-1", name: "smoke suite", examples: [], scorer: { id: "exact", kind: "exact_match" }, tags: [] },
          actuals: {},
        },
      },
    ]),
  },
};

async function main(): Promise<void> {
  const missing = AUTHORING_TASK_CATALOG.filter((t) => !SCRIPT[t.id]);
  if (missing.length > 0) {
    console.error(`familiarity-evals ci-gate: no scripted response for task(s): ${missing.map((t) => t.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const store = createFsStore(`/tmp/aart-familiarity-evals-ci-gate-${Date.now()}`);
  const validate = createRealValidateFn(store);
  const runSuccess = createRealRunSuccessFn(store);
  const modelRunner = createFakeModelRunner(SCRIPT);

  // try/finally, not a happy-path-only call after this block: createRunSuccess
  // dispatches candidate workflows through a REAL @aart/engine + real
  // @aart/blocks-core catalog, and two of this suite's own tasks
  // (verify-page-renders, fill-web-form-and-screenshot) author browser.*
  // steps — which lazily launch a real, shared headless Chromium
  // (@aart/blocks-core's browser-session.ts). That module's own doc comment
  // names the SEAM explicitly: nothing in @aart/blocks-core itself ever
  // closes it; "the engine... or worker process is expected to call
  // closeBrowserSession(runId)... and closeAllBrowserSessions() on graceful
  // shutdown." ci-gate.ts IS that composition root (the same role
  // packages/mcp/src/real-context.ts / packages/server play for their own
  // real engines) and, until this fix, never discharged that duty: the
  // shared Chromium subprocess (launched with --remote-debugging-pipe)
  // stayed alive after main() returned, and its still-open CDP pipe file
  // descriptors kept Node's event loop non-empty forever — main() would
  // finish, set process.exitCode, and return, but the OS process never
  // exited (confirmed directly: ps/lsof on a hung repro showed exactly one
  // leaked chrome-headless-shell child plus its two open pipe fd pairs,
  // nothing else). This is why GitHub Actions run 29148548882 hung on this
  // exact step for 30+ minutes. Matches every @aart/blocks-core browser-block
  // test's own established teardown (e.g. browser/goto.test.ts's
  // `afterAll(() => closeAllBrowserSessions())`) — here as a `finally` so it
  // runs on the pass path, the "some tasks failed" early-return path, AND if
  // runFamiliarityEvalSuite itself throws, matching this function's own
  // catch-and-set-exitCode-1 contract at the bottom of this file.
  try {
    const { results, metrics } = await runFamiliarityEvalSuite(AUTHORING_TASK_CATALOG, modelRunner, { validate, runSuccess });

    console.log("familiarity-evals CI gate (fake model — see this file's own doc comment for why no real model is used here):\n");
    for (const r of results) {
      const status = r.passed ? "PASS" : "FAIL";
      console.log(`  [${status}] ${r.taskId}  firstDraftValid=${r.firstDraftValid} correctBlockChoice=${r.correctBlockChoice} ranSuccessfully=${r.ranSuccessfully} score=${r.score.toFixed(2)}`);
    }
    console.log(`\nMetrics: firstDraftValidityRate=${metrics.firstDraftValidityRate.toFixed(2)} averageLoopsToValid=${metrics.averageLoopsToValid} correctBlockChoiceRate=${metrics.correctBlockChoiceRate.toFixed(2)}`);

    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      console.error(`\nfamiliarity-evals ci-gate: ${failed.length}/${results.length} task(s) failed.`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nfamiliarity-evals ci-gate: all ${results.length} tasks passed (fake-model harness verification — not a real-model baseline, see module doc comment).`);
  } finally {
    await closeAllBrowserSessions();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
