#!/usr/bin/env node
// The review-cycle flagship-workflow E2E test's WORKER PROCESS: the test
// harness must genuinely kill and restart the worker process (not just
// reload an in-memory store handle) between at least one wait and its
// resume. This script IS the worker process — review-cycle.e2e.test.ts
// spawns it via node:child_process, sends it real SIGKILL, and spawns a
// completely fresh instance of it to resume, reading only the on-disk
// store (never anything held in a prior process's memory).
//
// A plain .mjs, not a vitest test file, because the whole point is running
// as a genuinely separate OS process — vitest's own process cannot be "the
// worker that gets killed" without also killing the test runner observing
// it. Same convention this repo already established for exactly this kind
// of "must run as its own real process" concern — scripts/smoke/*.mjs
// (isolated-vm.mjs, browser.mjs).
//
// Imports @aart/mcp's real-context.js via a RELATIVE path to the COMPILED
// dist/ output (not the package's own name/exports map) —
// buildRealCatalog/createRealEngine give the fuller real Engine
// (redact/capabilityCheck/getGrantedCapabilities all real, per
// createRealEngine's own composition) that this script needs to also
// register the domain-pack-shaped fixture blocks into (see below) before
// constructing the engine; @aart/mcp's public index.js only exports the
// narrower EnginePort-wrapped createRealAartContext, which has no seam for
// adding extra blocks to the real 56-block catalog. A relative import is
// not subject to the package's exports-map restriction (that only gates
// bare-specifier "@aart/mcp/..." resolution) - this only requires `pnpm
// run build` to have already produced packages/mcp/dist/, same
// precondition every other test in this repo already has.
//
// Deliberately industry-neutral (AMENDMENTS.md A70): this file replaces a
// former worker script — the domain-pack fixture blocks below used to be
// named under a namespace tied to a specific customer/domain narrative
// removed from the product (2026-07-14, zero customer/domain-specific
// content). Renamed to a
// neutral `demo.*` namespace; every behavior is unchanged.
import { buildRealCatalog, createRealEngine } from "../../dist/real-context.js";
import { createFsStore } from "@aart/store";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Domain-pack-shaped fixture blocks (a neutral `demo.*` namespace) — none
// are real, shipped blocks. Matches
// packages/engine/src/guarded-loop.test.ts's own established precedent for
// the exact same two pre-existing ids (demo.compute_window, demo.compute)
// - extended here with the two additional domain-pack ids this fuller
// flagship workflow references (demo.parse, demo.validate, demo.render).
// capabilities: [] on every one, matching the same established precedent -
// capability-grant testing is not this E2E test's concern (dev trust mode,
// which this script's engine runs under, grants the full capability
// closure unconditionally regardless).
// ---------------------------------------------------------------------------

function fixtureManifest(id, description) {
  return { id, version: "0.1.0", capabilities: [], inputSchema: {}, outputSchema: {}, description };
}

const domainFixtureBlocks = {
  "demo.parse": {
    manifest: fixtureManifest("demo.parse", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => ({ structuredText: String(input.rawText ?? "") }),
  },
  "demo.validate": {
    manifest: fixtureManifest("demo.validate", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => {
      const recordCode = String(input.recordCode ?? "");
      // A generic 10-or-11-digit code format - this fixture's one
      // deterministic validation rule, just enough to prove "deterministic
      // validation" is a genuinely separate step from the LLM extraction it
      // consumes ("LLM extracts/drafts. Deterministic code validates.").
      const valid = /^\d{10,11}$/.test(recordCode);
      return { valid, issues: valid ? [] : [`record code "${recordCode}" is not a valid 10-11 digit code`] };
    },
  },
  "demo.compute": {
    manifest: fixtureManifest("demo.compute", "fixture - domain-pack-shaped, not a real shipped block. Reuses the exact id packages/engine/src/guarded-loop.test.ts's own fragment already established."),
    execute: async (input) => ({ recordId: input.recordId, estimatedValue: 1284.5, recommendedTier: "Standard Tier B" }),
  },
  "demo.render": {
    manifest: fixtureManifest("demo.render", "fixture - domain-pack-shaped, not a real shipped block"),
    execute: async (input) => ({
      recordId: input.recordId,
      summary: `Recommended tier: ${input.scoring?.recommendedTier ?? "unknown"}. Estimated annual value: $120.`,
    }),
  },
  "demo.compute_window": {
    manifest: fixtureManifest("demo.compute_window", "fixture - domain-pack-shaped, not a real shipped block. Reuses the exact id packages/engine/src/guarded-loop.test.ts's own fragment already established."),
    // Unlike guarded-loop.test.ts's own simplified always-past stand-in
    // (that test never needs a MEANINGFUL date, just an immediately-due
    // one), this fixture does the REAL 120-days-before computation - this
    // E2E test's nextReviewDate flows from the (faked) LLM extraction, and
    // proving that value correctly reaches this computation is part of
    // what this test demonstrates.
    execute: async (input) => {
      const nextReviewDate = new Date(String(input.nextReviewDate));
      const resumeAt = new Date(nextReviewDate.getTime() - 120 * 24 * 60 * 60 * 1000);
      return { resumeAt: resumeAt.toISOString() };
    },
  },
};

// ---------------------------------------------------------------------------
// Fake Anthropic client (AnthropicClientLike) - no real LLM provider API
// key is available in this environment (verified: none of
// ANTHROPIC_API_KEY/OPENAI_API_KEY/GOOGLE_API_KEY/GEMINI_API_KEY are set).
// Injected via buildRealCatalog's llmOptions (packages/mcp/src/
// real-context.ts, RealCatalogLlmOptions) - the REAL llm.extract block
// still runs its real dispatch/schema-validation/retry logic; only the
// network call this client.messages.create replaces is faked. Returns
// plausible, INTERNALLY CONSISTENT extracted fields (a next-review date
// ~200 days out, so compute_next_window's 120-days-before result is
// clearly in the future - this test does not attempt to also resolve wait
// #3's timer wait, so an immediately-due resumeAt would be misleading
// about what was actually exercised).
// ---------------------------------------------------------------------------

const REVIEW_DATE = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString();

const fakeAnthropicClient = {
  messages: {
    async create() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              recordCode: "63051234567",
              totalAmount: 184.2,
              quantity: 612,
              category: "Standard Tier A",
              nextReviewDate: REVIEW_DATE,
            }),
          },
        ],
        usage: { input_tokens: 42, output_tokens: 17 },
      };
    },
  },
};

function buildEngine(root) {
  const store = createFsStore(root);
  const catalog = buildRealCatalog(store, { anthropic: { client: fakeAnthropicClient } });
  const blocks = { ...catalog.blocks, ...domainFixtureBlocks };
  // "dev" passed explicitly (AMENDMENTS.md A48: createRealEngine's
  // trustMode param is required, not silently defaulted) — this script's
  // own header comment already documents the operating assumption this
  // preserves byte-for-byte: "dev trust mode, which this script's engine
  // runs under, grants the full capability closure unconditionally
  // regardless," since capability-grant gating is not what this E2E proves
  // (every domain-pack fixture block also declares capabilities: []
  // independently, per that same comment).
  const engine = createRealEngine(store, blocks, "dev");
  return { store, engine };
}

function emit(event) {
  // One JSON line per event on stdout - the test process reads this to
  // know exactly when it's safe to SIGKILL (only after "waiting" has been
  // printed, which only happens after executeRun/resumeApproval has
  // already RETURNED - i.e. the wait was already durably persisted to
  // the on-disk store before this process is killed, not merely held in
  // this process's own memory).
  process.stdout.write(JSON.stringify(event) + "\n");
}

function waitingStepId(run) {
  for (let i = run.trace.length - 1; i >= 0; i--) {
    if (run.trace[i].status === "waiting") return run.trace[i].stepId;
  }
  return undefined;
}

async function hangForever() {
  // Deliberately never resolves - keeps this OS process alive so the test
  // can SIGKILL a genuinely still-running process, not just sequence two
  // short-lived scripts. NOTE: a bare `await new Promise(() => {})` is NOT
  // sufficient here - an unresolved Promise has no associated libuv handle
  // (no timer/socket/etc backing it), so it does not, by itself, keep
  // Node's event loop non-empty; Node exits as soon as the loop has no
  // other pending work, regardless of an outstanding never-resolving
  // await (verified directly: an earlier version of this script using
  // exactly that exited immediately instead of hanging). A recurring
  // setInterval IS a real libuv handle, so it genuinely keeps the process
  // alive until something external (SIGKILL) ends it - the callback body
  // is never meant to run, only the timer's mere existence matters.
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root;
  if (!root) throw new Error("--root=<store path> is required");

  if (args.mode === "trigger") {
    const { store, engine } = buildEngine(root);
    const workflowPath = args.workflow;
    const { readFile } = await import("node:fs/promises");
    const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
    await store.workflows.put(workflow);

    const run = await engine.triggerRun({
      workflow,
      trigger: { id: "e2e-trigger-1", type: "manual", source: "review-cycle.e2e.test", payload: null, receivedAt: new Date().toISOString() },
      inputs: { recordId: args.recordId, documentText: args.documentText },
    });
    const finished = await engine.executeRun(run.runId);
    emit({ event: "result", runId: finished.runId, status: finished.status, stepId: waitingStepId(finished) });
    if (finished.status === "waiting") await hangForever();
    return;
  }

  if (args.mode === "resume") {
    const { engine } = buildEngine(root);
    const outcome = await engine.resumeApproval(args.runId, args.stepId, {
      id: `${args.runId}:${args.stepId}:decision`,
      status: args.decision,
      decision: { note: args.note ?? "" },
      reviewer: args.reviewer ?? "e2e-test-reviewer",
    });
    if (outcome.kind !== "resumed") {
      emit({ event: "resume-failed", kind: outcome.kind, mechanism: outcome.mechanism });
      process.exitCode = 1;
      return;
    }
    emit({ event: "result", runId: outcome.run.runId, status: outcome.run.status, stepId: waitingStepId(outcome.run) });
    if (args.hang === "true" && outcome.run.status === "waiting") await hangForever();
    return;
  }

  throw new Error(`Unknown --mode="${args.mode}" (expected "trigger" or "resume")`);
}

main().catch((err) => {
  emit({ event: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
