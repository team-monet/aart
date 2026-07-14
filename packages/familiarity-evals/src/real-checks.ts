// real-checks.ts — the real ValidateFn/RunSuccessFn wiring this package's
// own doc comments name as "S9's job" (index.ts: "This session does NOT
// wire CI or run a real-model baseline — that's S9's job"; validate.ts/
// run-success.ts: "S9 wires the real engine-backed check in later").
//
// Mirrors packages/mcp/src/real-context.ts's/packages/dashboard/src/
// capability-catalog.ts's own established pattern for this exact class of
// wiring (build the real @aart/blocks-core + @aart/llm catalog, bind real
// @aart/governance/@aart/engine functions to it) — NOT imported from
// either sibling (same reasoning as capability-catalog.ts's own doc
// comment: each client/consumer calls the same UNDERLYING @aart/governance/
// @aart/engine/@aart/blocks-core functions, it does not depend on a
// sibling's own composition-root code).
import { closeBrowserSession, createBlockCatalog } from "@aart/blocks-core";
import { alwaysAllowCapabilityCheck, createEngine, identityRedactFn, type BlockRegistry } from "@aart/engine";
import { computeCapabilityClosure, validateWorkflow, type CapabilityClosureLookup, type CapabilityClosureNode } from "@aart/governance";
import { createLlmPack } from "@aart/llm";
import { createFsStore, recordRunTerminalEvent, type AartStore } from "@aart/store";
import type { ValidateFn, RunSuccessFn } from "./types.js";

// A fake Anthropic client (AnthropicClientLike, matching
// packages/mcp/src/e2e/review-cycle-worker.mjs's own established use of
// this exact injection point) — this package has no legitimate use for a
// REAL provider call: an authoring TASK's own scripted/model-generated
// candidate workflow may itself contain an llm.call/llm.extract/
// llm.classify STEP (e.g. the "call-llm-with-schema" task in
// tasks/catalog.ts), and createRealRunSuccessFn actually EXECUTES that
// candidate — a run-success check is not the place a real external model
// call belongs regardless of whether a provider key happens to be set
// (this is about hermeticity/determinism, not just this environment's own
// missing key). Returns a generic, schema-agnostic canned response —
// good enough to satisfy "the step dispatched and returned a
// schema-shaped result," which is all createRealRunSuccessFn checks.
const fakeAnthropicClient = {
  messages: {
    async create() {
      return { content: [{ type: "text", text: JSON.stringify({ label: "example" }) }], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  },
};

/** The real core-builtin catalog (56 blocks: 51 @aart/blocks-core + 5 @aart/llm) — same composition every other real-checks/composition-root in this repo builds, here scoped to just this package's own two needs (a known-block-id list for validation; a real BlockRegistry for run-success). */
function buildCatalog(store: AartStore): BlockRegistry {
  const coreBlocks = createBlockCatalog();
  const llmBlocks = createLlmPack({ store, anthropic: { client: fakeAnthropicClient } }).blocks;
  const blocks: BlockRegistry = {};
  for (const impl of [...coreBlocks, ...llmBlocks]) blocks[impl.manifest.id] = impl;
  return blocks;
}

function buildCapabilityClosureLookup(blocks: BlockRegistry): CapabilityClosureLookup {
  return {
    resolve(blockId: string): CapabilityClosureNode | undefined {
      const impl = blocks[blockId];
      if (!impl) return undefined;
      return { kind: "block", capabilities: impl.manifest.capabilities };
    },
  };
}

/**
 * The real `aart_validate` (@aart/governance's validateWorkflow), replacing
 * validate.ts's own documented "lightweight REFERENCE validator... does NOT
 * implement capability validation, input-safety validation, or deployment
 * validation." Runs the FULL 5-class validation (spec §18.1-18.5) a real
 * candidate workflow authored against AART's real tool surface would face.
 * `trustMode: "dev"` — this suite measures whether a MODEL can author a
 * valid workflow, not whether a particular trust-mode's capability grants
 * would additionally approve it (a separate, real concern this suite
 * doesn't otherwise touch).
 */
export function createRealValidateFn(store: AartStore): ValidateFn {
  const blocks = buildCatalog(store);
  const lookup = buildCapabilityClosureLookup(blocks);
  const knownBlockIds = Object.keys(blocks);
  return (workflow: unknown) => {
    const result = validateWorkflow(workflow, { blockCatalog: lookup, knownBlockIds, trustMode: "dev" });
    return { valid: result.valid, errors: result.findings.map((f) => `[${f.class}] ${f.path}: ${f.message}`) };
  };
}

/**
 * The real @aart/engine-backed run-success check, replacing run-success.ts's
 * own documented "lightweight REFERENCE run-success checker... NOT a real
 * @aart/engine execution." Actually triggers and executes the candidate
 * workflow against the real 56-block catalog. `capabilityCheck:
 * alwaysAllowCapabilityCheck`/`redact: identityRedactFn` — this suite is
 * measuring whether the AUTHORED WORKFLOW runs, not exercising governance's
 * separate capability-approval or redaction machinery (both real and
 * already covered by their own dedicated test suites elsewhere in this
 * repo) — matching packages/engine/src/guarded-loop.test.ts's own
 * established convention for the exact same reasoning.
 *
 * A run reaching ANY of "completed"/"waiting" counts as success — an
 * authoring task that correctly produces a workflow which legitimately
 * pauses on a real wait primitive (e.g. wait-for-human-approval, wait.until
 * a webhook) is a CORRECT authoring outcome, not a failure to run; only
 * "failed"/"cancelled" (or a thrown dispatch error, e.g. an unresolvable
 * block reference) counts as a run-success failure.
 *
 * `onRunTerminal: (runId) => closeBrowserSession(runId)` — the identical
 * hook packages/mcp/src/real-context.ts's own createRealEngine wires for
 * the SAME reason (that file's own comment: "@aart/blocks-core's
 * closeBrowserSession"), completing the composition-root pattern this
 * file's header comment already says it mirrors. Two of this suite's own
 * tasks (verify-page-renders, fill-web-form-and-screenshot) author
 * browser.* steps, which lazily launch a real, shared headless Chromium
 * (@aart/blocks-core's browser-session.ts) — that module's own doc comment
 * names the SEAM explicitly: nothing in @aart/blocks-core itself ever
 * closes a run's session; the engine composition root is expected to.
 * Without this, each task's BrowserContext/Page would stay open for the
 * rest of the process's life instead of being released as soon as that
 * task's run goes terminal (the shared Chromium PROCESS itself is a
 * separate, coarser resource — closed once, by ci-gate.ts's own final
 * closeAllBrowserSessions(), not per-run here).
 *
 * `recordRunTerminalEvent` (AMENDMENTS.md A61, V1 event log foundation,
 * RISK 1) added alongside it — this is the SECOND of exactly two real
 * `createEngine(...)` composition roots in the workspace (the other:
 * packages/mcp/src/real-context.ts's `createRealEngine`, verified directly
 * by grepping every `createEngine(` call site, per this session's own
 * explicit instruction to check this package too) — a genuinely separate
 * Engine instance over this package's own store, not reachable through the
 * mcp/cli/server composition at all, so it needs its own copy of the hook
 * rather than inheriting the other one's fix. Ordered first, same reasoning
 * as real-context.ts's own createRealEngine: never-throwing, so
 * closeBrowserSession still runs regardless.
 */
export function createRealRunSuccessFn(store: AartStore): RunSuccessFn {
  const blocks = buildCatalog(store);
  const engine = createEngine({
    store,
    redact: identityRedactFn,
    capabilityCheck: alwaysAllowCapabilityCheck,
    blocks,
    onRunTerminal: async (runId) => {
      await recordRunTerminalEvent(store, runId);
      await closeBrowserSession(runId);
    },
  });
  void computeCapabilityClosure; // referenced for symmetry with createRealValidateFn's lookup construction - this function doesn't itself need a closure (capabilityCheck is unconditional here)

  return async (workflow: unknown) => {
    const parsed = workflow as { id?: string; version?: string };
    if (!parsed?.id || !parsed?.version) return { succeeded: false, error: "workflow is missing id/version — cannot trigger a run" };
    try {
      // The engine resolves a run's step definitions by looking the
      // workflow up in the store by (id, version) - triggerRun's own
      // documented contract does NOT persist the Workflow itself (S1
      // SEAMS Seam 3), so this caller must put() it first (same
      // precondition every other real-engine call site in this repo
      // follows - verified directly against triggerRun's own failure
      // mode when this step is skipped, not assumed).
      await store.workflows.put(workflow as Parameters<typeof store.workflows.put>[0]);
      const run = await engine.triggerRun({
        workflow: workflow as Parameters<typeof engine.triggerRun>[0]["workflow"],
        trigger: { id: `familiarity-eval-${parsed.id}`, type: "manual", source: "familiarity-evals-ci-gate", payload: null, receivedAt: new Date().toISOString() },
        inputs: {},
      });
      const finished = await engine.executeRun(run.runId);
      if (finished.status === "completed" || finished.status === "waiting") return { succeeded: true };
      const failedTrace = finished.trace.find((t) => t.status === "failed");
      return { succeeded: false, error: failedTrace?.error ?? `run ended with status "${finished.status}"` };
    } catch (err) {
      return { succeeded: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export { createFsStore };
