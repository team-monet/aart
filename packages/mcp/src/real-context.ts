// The REAL composition root (S9 integration, reconciliation ledger items
// 3/4/5/11) — replaces every documented stub-swap point S5's own SEAMS.md
// table named ("At merge: S9 replaces createStub*'s fields one-by-one with
// the real imports... swapping is a constructor-injection change in
// createAartContext"). This is that swap.
//
// What gets wired for real here:
//   - EnginePort  <- @aart/engine's real createEngine(config), fed the real
//     56-block catalog (@aart/blocks-core's 51 + @aart/llm's 5) and real
//     governance policy functions (redact/capabilityCheck/getGrantedCapabilities).
//   - GovernancePort <- @aart/governance's real exports directly (the port
//     type was already built to match them field-for-field, per S5's own
//     "zero adaptation at merge time" design).
//   - EvidencePort <- @aart/evidence's real createReportRenderers/
//     recordCorrection/createEvalExampleFromCorrection/runEvalSuite.
//   - RegistryPort <- @aart/registry's real findBlocks, fed a
//     BlockCatalogEntry[] assembled from the same real 56-block catalog
//     (core built-ins only - see the module doc comment on
//     buildLocalCatalog below for the documented v1 gap on pack-delivered
//     blocks).
//   - BundlerPort/RemotesPort (D1 "remotes + push", AMENDMENTS.md A56) <-
//     @aart/server's real produceBundle (the resolveAndProduceBundle bridge
//     below — the SAME function @aart/cli's real-server-port.ts now also
//     calls for its own ServerPort.produceBundle, one implementation, not
//     two) and a small, real (not simulated) remotes.json/secrets.json
//     reader (stubs/deploy.ts's createRemotesPort, exported here as
//     createRealRemotesPort — see that module's own doc comment for why
//     there's no meaningful stub-vs-real split for a plain JSON-file read).
//     Unlike every port above, these two are NOT CLI-only (ServerPort's own
//     documented exception) — see types.ts's BundlerPort/RemotesPort doc
//     comment for why.
//
// ServerPort is NOT built in this file and never has been — it isn't part
// of AartContext at all (CLI-only, architecture §13.3's stated exception;
// see types.ts's own ServerPort doc comment). This comment previously
// claimed it was wired "here" via "a real EngineBoundary adapter... this
// package's createRealEngineBoundary" — both halves of that claim were
// false when written (createRealEngineBoundary did not exist anywhere in
// the repo, and this file has no ServerPort-shaped export), flagged by
// A37 when that function was finally built and left uncorrected until now.
// The real, corrected story (AMENDMENTS.md A42): createRealEngineBoundary
// lives in @aart/server (packages/server/src/engine/boundary.ts, built
// A37); the ServerPort adapter that wraps it — createRealServerPort — lives
// in @aart/cli (packages/cli/src/real-server-port.ts, built A42), which
// pulls the raw Engine instance this file's createRealEngine constructs out
// through context.ts's createRealAartContextWithEngine (also A42) so the
// worker/server processes it starts share the exact same Engine (and
// therefore the exact same store-backed catalog/governance wiring) as the
// rest of that same CLI invocation's AartContext, rather than building a
// second, potentially-divergent one.
//
// Two DI hooks landed earlier in this same reconciliation pass get their
// real wiring here for the first time: EngineConfig.onRunTerminal ->
// @aart/blocks-core's closeBrowserSession (item 10), and
// EngineConfig.computePackHashes -> @aart/registry's computePackContentHash
// (item 8) - see buildPackHashComputer's doc comment for why the latter is
// scoped to core built-ins only, same reasoning as the catalog gap above.
import { createEngine, type BlockRegistry, type Engine, type GetGrantedCapabilities } from "@aart/engine";
import { closeBrowserSession, createBlockCatalog } from "@aart/blocks-core";
import {
  checkCapability,
  computeApprovalState,
  computeCapabilityClosure,
  computePromotionState,
  decodeWorkflowVersionApprovalSubject,
  evaluatePromotionForEnvironment,
  getGrantedCapabilities,
  isAartApproveRegisteredForMode,
  normalizeEnvironmentTrustMode,
  REQUIRED_GATES_BY_MODE,
  redactRecord,
  semanticRiskDiff,
  validateWorkflow,
  workflowVersionApprovalSubject,
  writeApprovalDecision,
  type CapabilityClosureLookup,
  type CapabilityClosureNode,
} from "@aart/governance";
import { computeEvalsGateStatus, createReportRenderers, recordCorrection as evidenceRecordCorrection, createEvalExampleFromCorrection as evidenceCreateEvalExampleFromCorrection, createScorerRegistry, runEvalSuite } from "@aart/evidence";
import { computePackContentHash, findBlocks, type BlockCatalogEntry } from "@aart/registry";
import { produceBundle as produceRealBundle, type Bundle } from "@aart/server";
import { createLlmPack, type CreateLlmPackOptions } from "@aart/llm";
import type { AartStore } from "@aart/store";
import type { BlockImplementation, Deployment, Signal, TrustMode, Workflow } from "@aart/types";
import type { BundleLike, BundlerPort, EnginePort, EvidencePort, GovernancePort, RegistryPort, RemotesPort, ResumeOutcome } from "./types.js";
import { newId } from "./stubs/engine.js";
import { createRemotesPort } from "./stubs/deploy.js";

// ---------------------------------------------------------------------------
// The real 56-block catalog: @aart/blocks-core's 51 core built-ins +
// @aart/llm's 5 llm.* blocks. Pack-delivered blocks are NOT included here -
// AartStore's PackManifestStore has no "list every known pack" primitive to
// enumerate them from (reconciliation ledger item 13's own documented v1
// gap), so a fresh dev store has no installed packs to fold in anyway. This
// is still a real, complete implementation of the documented core-builtin
// surface (spec's own "core-builtin total = 56" framing, P9 amendment) -
// not a placeholder like the 24-manifest catalog it replaces.
// ---------------------------------------------------------------------------

export interface RealCatalog {
  blocks: BlockRegistry;
  entries: readonly BlockCatalogEntry[];
  llmJudge: ReturnType<typeof createLlmPack>["llmJudge"];
}

/** Passthrough to `@aart/llm`'s own per-provider options (each one's own `client`/`fetcher` injection point — see that package's provider adapters) — added for S9's flagship E2E tests (`examples/redacted-legacy-b`, `examples/redacted-legacy-a`), which need to inject a fake provider client/fetcher (no real LLM API key is assumed present in every environment this runs in) while still exercising the REAL `llm.extract`/`llm.classify` block dispatch, schema validation, and retry logic — only the actual network call is faked. Omitted entirely (the pre-existing default), production code gets real provider adapters reading real API keys from `options.llm?.*.apiKey` or the adapters' own env-var fallback. */
export interface RealCatalogLlmOptions {
  anthropic?: CreateLlmPackOptions["anthropic"];
  openai?: CreateLlmPackOptions["openai"];
  google?: CreateLlmPackOptions["google"];
}

export function buildRealCatalog(store: AartStore, llmOptions?: RealCatalogLlmOptions): RealCatalog {
  const scorerRegistryPlaceholder = createScorerRegistry(); // llmJudge wired in below, once the llm pack exists (chicken/egg: the registry needs llmJudge, the catalog's eval blocks need the registry)
  const reportRenderers = createReportRenderers(redactRecord);
  const llmPack = createLlmPack({ store, ...llmOptions });

  const coreBlocks = createBlockCatalog({ scorerRegistry: createScorerRegistry({ llmJudge: llmPack.llmJudge }), reportRenderers });
  void scorerRegistryPlaceholder;

  const blocks: BlockRegistry = {};
  for (const impl of [...coreBlocks, ...llmPack.blocks]) {
    blocks[impl.manifest.id] = impl;
  }

  const entries: BlockCatalogEntry[] = Object.values(blocks).map((impl) => ({
    manifest: impl.manifest,
    examples: [],
  }));

  return { blocks, entries, llmJudge: llmPack.llmJudge };
}

// ---------------------------------------------------------------------------
// EngineConfig.getGrantedCapabilities adapter — the engine's real dispatch
// boundary calls this as `(workflow, environment) => string[]`
// (capability.ts's checkCapabilityDispatch, the only call site), but
// governance's real getGrantedCapabilities needs a richer
// GrantedCapabilitiesInput (trustMode/approvalState/capabilityClosure/
// riskTier/standingApprovals). This adapter derives each from what IS
// available at that call site:
//   - approvalState: workflow.approval directly.
//   - capabilityClosure/riskTier: computeCapabilityClosure walking
//     workflow.execution.steps against the real block registry.
//   - trustMode: resolved from the target Environment's own config.trustMode
//     (matching promotion.ts's requiredGatesForEnvironment - the SAME
//     established convention for "where does an environment's trust mode
//     live") via normalizeEnvironmentTrustMode when an environment IS
//     given; otherwise falls back to `defaultTrustMode`, the CALLER-SUPPLIED
//     ambient trust mode this run/process is actually operating under.
//   - standingApprovals: the full store list (StandingApprovalStore.list()
//     takes no filter args) - governance's own findMatchingStandingApproval
//     does the actual per-approval matching internally.
//
// AMENDMENTS.md (S15, settling the S11/A42 governance-permissiveness
// finding): `defaultTrustMode` was previously hardcoded to the literal
// string `"dev"` here, unconditionally, for EVERY run that doesn't carry an
// `environment` — which is every `aart run`/`aart_run_workflow` call (the
// shared handler never threads one; RunWorkflowInput has no environment
// field at all) and, until this same session's server-side fix
// (triggers/registry.ts's `deploymentToBinding`, engine/boundary.ts's
// `startRun`), every trigger-fired (webhook/schedule/etc.) run too. Because
// `getGrantedCapabilities` grants the FULL capability closure unconditionally
// whenever `trustMode === "dev"` (this package's own documented dev-mode
// semantics, spec §17.2: "draft workflows can run with warning"), that
// hardcoded fallback made the real architecture §4.6 capability-dispatch
// chokepoint a no-op for direct CLI/MCP runs regardless of the ambient,
// correctly-resolved `ctx.trustMode` (which defaults to spec §17.2's own
// "Local development default: governed" and WAS already being recorded
// correctly onto `RunRecord.approvalMode` for audit purposes — just never
// consulted by the actual enforcement path). An unapproved, Medium-risk
// workflow could run to completion under the default `governed` mode simply
// because `aart run` has no `--environment` flag to attach. The fix: this
// factory now REQUIRES its caller to supply the real ambient trust mode as
// `defaultTrustMode` (no more silent, un-overridable literal) — the
// authoring-loop freedom spec §17.2 documents ("Experimental override: dev")
// remains fully available, but only when a caller actually asked for `dev`
// (an explicit `AART_TRUST_MODE=dev` / `trustMode: "dev"` option), never as
// an accidental side effect of omitting `--environment`.
//
// Documented simplification: capability-closure resolution only recognizes
// BLOCK ids present in the real registry - a step referencing another
// REGISTERED WORKFLOW as a block (S1 SEAMS Seam 6's "a registered workflow
// is additionally dispatchable as a workflow-type block") resolves as
// unresolved rather than recursively walking that workflow's own steps.
// computeCapabilityClosure's own contract surfaces unresolved ids rather
// than silently dropping them (a separate validation class's concern, not
// a capability-grant correctness bug) - full nested-workflow-as-block
// capability recursion is real, separate feature work beyond this
// integration pass's surgical-patch mandate, not attempted here.
// ---------------------------------------------------------------------------
/** Shared by createGetGrantedCapabilities and the semanticRiskDiff adapter below — both need to resolve a step's block id to its declared capabilities against the same real registry. See createGetGrantedCapabilities's own doc comment for the documented nested-workflow-as-block simplification this lookup carries. */
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
 * @param defaultTrustMode The trust mode to use for capability-grant
 * resolution when a run carries no `environment` (every direct
 * `aart run`/`aart_run_workflow`/`aart eval run` call, today's only such
 * callers — see this function's own doc comment above). REQUIRED, not
 * defaulted: callers must state which trust mode they're actually
 * constructing this engine under (the real composition root passes the
 * genuinely-resolved `ctx.trustMode`; a test/fixture that deliberately wants
 * unconditional dev-mode grants passes `"dev"` explicitly, never by omission).
 */
export function createGetGrantedCapabilities(store: AartStore, blocks: BlockRegistry, defaultTrustMode: TrustMode): GetGrantedCapabilities {
  const lookup = buildCapabilityClosureLookup(blocks);

  return async (workflow: Workflow, environment: string | undefined): Promise<string[]> => {
    const closure = computeCapabilityClosure(workflow.execution.steps, lookup);

    let trustMode: TrustMode = defaultTrustMode;
    if (environment) {
      const env = await store.environments.get(environment);
      trustMode = normalizeEnvironmentTrustMode(env?.config["trustMode"]);
    }

    const standingApprovals = await store.standingApprovals.list();

    return getGrantedCapabilities({
      trustMode,
      approvalState: workflow.approval,
      capabilityClosure: closure.capabilities,
      riskTier: closure.riskTier,
      standingApprovals,
    });
  };
}

// ---------------------------------------------------------------------------
// EngineConfig.computePackHashes adapter (reconciliation ledger item 8) -
// same documented scope limitation as buildRealCatalog above: only
// core-built-in blocks are in the registry today (no pack-provenance
// mapping exists to walk), so this always resolves to an empty record. Once
// pack-delivered blocks are wired into the catalog (item 13's own tracked
// gap), this is the function to extend with a real packName->version
// resolution feeding @aart/registry's computePackContentHash - the plumbing
// (EngineConfig.computePackHashes's DI seam) is already real and wired;
// only the "which packs does this workflow actually use" input is the
// still-open part, and it does not exist because no pack is installed by
// default in a fresh store.
// ---------------------------------------------------------------------------
export function createComputePackHashes() {
  return async (_workflow: Workflow, _blocks: BlockRegistry): Promise<Record<string, string>> => {
    void _workflow;
    void _blocks;
    void computePackContentHash; // referenced so the real function this will call once packs exist is visibly imported here, not silently forgotten
    return {};
  };
}

// ---------------------------------------------------------------------------
// The real Engine instance + its EnginePort adapter for @aart/mcp/@aart/cli.
// ---------------------------------------------------------------------------

/** @param trustMode Threaded straight into `createGetGrantedCapabilities` — see that function's doc comment for why this is a required, explicit parameter rather than a silently-defaulted one (AMENDMENTS.md, S15). */
export function createRealEngine(store: AartStore, blocks: BlockRegistry, trustMode: TrustMode): Engine {
  return createEngine({
    store,
    redact: redactRecord,
    capabilityCheck: checkCapability,
    getGrantedCapabilities: createGetGrantedCapabilities(store, blocks, trustMode),
    blocks,
    computePackHashes: createComputePackHashes(),
    onRunTerminal: (runId) => closeBrowserSession(runId),
  });
}

/** Synthesizes the two Signal fields (`id`/`receivedAt`) EnginePort's narrower resumeBySignal input doesn't carry but the real, frozen Signal type requires - this adapter's own bookkeeping, not persisted/observable data (the real resumeBySignal implementation matches purely on name+correlationId, per S1 SEAMS Seam 1's wait/signal-matching contract - id/receivedAt play no role in the match itself). */
function toRealSignal(input: { name: string; correlationId: string; payload?: unknown }): Signal {
  return { id: newId("sig"), name: input.name, correlationId: input.correlationId, payload: input.payload, receivedAt: new Date().toISOString() };
}

export function createRealEnginePort(engine: Engine): EnginePort {
  return {
    triggerRun: (input) => engine.triggerRun(input),
    executeRun: (runId) => engine.executeRun(runId),
    resumeManual: (runId, stepId, payload) => engine.resumeManual(runId, stepId, payload) as Promise<ResumeOutcome>,
    resumeBySignal: (signal) => engine.resumeBySignal(toRealSignal(signal)) as Promise<ResumeOutcome>,
    resumeApproval: (runId, stepId, task) => engine.resumeApproval(runId, stepId, task) as Promise<ResumeOutcome>,
  };
}

// ---------------------------------------------------------------------------
// GovernancePort — mostly a direct pass-through (built by S5 to match
// @aart/governance's real exports field-for-field), but TWO fields needed a
// real adapter, not a bare reference — verified by actually building this
// (not assumed from the port type alone):
//
//   - `validateWorkflow(input: unknown): ValidationResultShape` (this
//     package's port) vs. governance's real
//     `validateWorkflow(input: unknown, context: ValidationContext): FullValidationResult`
//     — the real function needs a `ValidationContext` (blockCatalog lookup,
//     knownBlockIds, trustMode at minimum) this package's own narrower port
//     type has nowhere to carry per-call, so `trustMode` and `blocks` are
//     bound at PORT-CONSTRUCTION time instead (consistent with how
//     `AartContext.trustMode` is itself resolved once per process/CLI
//     invocation, not per call, elsewhere in this codebase).
//   - `semanticRiskDiff(from: Workflow, to: Workflow)` (this package's port)
//     vs. governance's real `semanticRiskDiff(from: {steps, capabilityClosure}, to: {...})`
//     — needs each side's capability closure computed first, using the
//     SAME lookup `validateWorkflow`'s adapter uses.
//
// Documented simplification (both adapters): `standingApprovals` is left
// unresolved (undefined) — governance's real functions are exposed as
// SYNCHRONOUS here (matching this package's own port type, which has no
// Promise-wrapped validateWorkflow/semanticRiskDiff), so there is no
// correctness-safe place in a sync call to fetch the store's current
// standing-approvals list without either going async (a port-type change)
// or risking a stale snapshot cached at construction time. Conservative
// (fail-closed, not fail-open): a workflow this WOULD grant a capability to
// via a standing approval instead validates/diffs as if no standing
// approval applied — under-granting, never over-granting.
//
// `ValidationContext.packSealChecks` (reconciliation ledger item 12) is left
// unpopulated here too, for a genuine (not lazily-deferred) reason distinct
// from `standingApprovals` above — verified, not assumed:
//   1. @aart/registry's real computePackSealChecks(store, packs,
//      packageManager) is I/O-bound async (a store read + a package
//      install per pack) — the exact same sync/async wall standingApprovals
//      hits, for the same reason (this port's validateWorkflow has no
//      Promise-wrapped call site to await one).
//   2. Even setting (1) aside, there is today no DATA to feed it: this
//      module's own buildRealCatalog only folds @aart/blocks-core +
//      @aart/llm into the catalog (documented gap, item 13) — no
//      pack-delivered block is ever resolvable via `blocks`/`entries`
//      today, so walking a workflow's steps for `packName` references
//      (BlockCatalogEntry.packName) always yields the empty set, on a
//      fresh dev store or any other. A helper that does this walk would be
//      dead code with nothing to call it into, so none is added.
//   3. Independent of (1)/(2): AartStore.packManifests has no "current/
//      latest version of pack X" primitive (get() requires an exact
//      version; listVersions() returns every known version, unordered by
//      contract) and no Workflow field pins which pack version it depends
//      on — "which (name, version) pairs does this workflow use" has no
//      well-defined answer yet even with real installed packs. Resolving
//      that is a data-model decision (a pack-version-pinning field, and/or
//      a "latest" convention) beyond this integration pass's mandate.
// Same resolution shape as EngineConfig.computePackHashes (item 8) above,
// applied consistently rather than re-litigated: real DI plumbing exists on
// governance's side (ValidationContext.packSealChecks is a real, already-
// wired optional field — validateCapabilities already reads it), but there
// is nothing correct to compute from here until item 13's catalog gap AND
// a pack-version-pinning primitive both land. Until then, omitting the
// field is the CORRECT output (not a stand-in for one), not just the
// convenient one — validateCapabilities treats a missing packSealChecks
// identically to an empty array (`context.packSealChecks ?? []`).
// ---------------------------------------------------------------------------

export function createRealGovernancePort(blocks: BlockRegistry, trustMode: TrustMode): GovernancePort {
  const lookup = buildCapabilityClosureLookup(blocks);
  const knownBlockIds = Object.keys(blocks);

  return {
    requiredGatesByMode: REQUIRED_GATES_BY_MODE,
    isAartApproveRegisteredForMode,
    computeApprovalState,
    computePromotionState,
    evaluatePromotionForEnvironment,
    validateWorkflow: (input) => validateWorkflow(input, { blockCatalog: lookup, knownBlockIds, trustMode }),
    semanticRiskDiff: (from, to) =>
      semanticRiskDiff(
        { steps: from.execution.steps, capabilityClosure: computeCapabilityClosure(from.execution.steps, lookup) },
        { steps: to.execution.steps, capabilityClosure: computeCapabilityClosure(to.execution.steps, lookup) },
      ),
    redact: redactRecord,
    workflowVersionApprovalSubject,
    decodeWorkflowVersionApprovalSubject,
    writeApprovalDecision,
  };
}

// ---------------------------------------------------------------------------
// EvidencePort — @aart/evidence's real exports. `runEval` binds to
// runEvalSuite fed a real engine-backed `execute` (per SEAMS.md's own
// documented expectation: "S9 should inject... an engine-backed run-success
// check" for anything that used to be a stub's fake execution) - each
// example's input is run as a REAL triggerRun+executeRun against the real
// engine, not the simulated step semantics the former stub used.
// ---------------------------------------------------------------------------

export function createRealEvidencePort(store: AartStore, engine: Engine): EvidencePort {
  const renderers = createReportRenderers(redactRecord);

  return {
    modelFacingReport: (run) => renderers.modelFacing(run),
    markdownReport: (run) => renderers.markdown(run),
    recordCorrection: (input) => evidenceRecordCorrection(store, input),
    createEvalExampleFromCorrection: (correction, suiteId) => evidenceCreateEvalExampleFromCorrection(store, correction, suiteId),

    async runEval(suite, workflowId, workflowVersion) {
      const workflow = await store.workflows.get(workflowId, workflowVersion);
      if (!workflow) throw new Error(`runEval: workflow ${workflowId}@${workflowVersion} not found`);
      const scorers = createScorerRegistry();
      const result = await runEvalSuite(suite, {
        scorers,
        workflowId,
        workflowVersion,
        reportArtifact: "",
        async execute(input) {
          const inputs = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
          const created = await engine.triggerRun({
            workflow,
            trigger: { id: newId("trig"), type: "mcp", source: "aart_run_eval", payload: inputs, receivedAt: new Date().toISOString() },
            inputs,
          });
          const finished = await engine.executeRun(created.runId);
          return finished.outputs ?? {};
        },
      });
      return result.evalRun;
    },

    computeEvalsGateStatus,
  };
}

// ---------------------------------------------------------------------------
// RegistryPort — @aart/registry's real findBlocks, fed the real catalog.
//
// Two adaptations, not a direct pass-through:
//   1. Shape: @aart/registry's real BlockSearchResult is FLAT
//      (`BlockCatalogEntry & {score}`); @aart/mcp's own BlockSearchResult
//      is NESTED (`{entry: BlockCatalogEntry; score}, per this package's
//      own types.ts). Verified by direct comparison before wiring - a
//      naive pass-through here would silently return objects with no
//      `.entry` property, breaking every caller.
//   2. `category` filtering: this package's RegistryPort.findBlocks accepts
//      an optional `category` filter (its own stub, createStubRegistry,
//      supported it); @aart/registry's real findBlocks has no such
//      parameter at all (FindBlocksInput has no category field). Applied
//      as a post-filter here so this package's existing category-filtering
//      behavior/tests are preserved exactly, not silently dropped.
// ---------------------------------------------------------------------------

export function createRealRegistryPort(entries: readonly BlockCatalogEntry[]): RegistryPort {
  return {
    findBlocks(input) {
      const results = findBlocks({ query: input.query, scope: "local", localCatalog: entries });
      const filtered = input.category ? results.filter((r) => r.manifest.category === input.category) : results;
      return filtered.map(({ score, ...entry }) => ({ entry, score }));
    },
    listBlocks: () => entries,
    getBlock: (id) => entries.find((e) => e.manifest.id === id),
  };
}

// ---------------------------------------------------------------------------
// BundlerPort / RemotesPort — D1 "remotes + push" (AMENDMENTS.md A56).
// `resolveAndProduceBundle` is the resolveDeployment/bundleToBundleLike
// bridge EXTRACTED from `@aart/cli`'s `real-server-port.ts` — that package's
// own `ServerPort.produceBundle` now imports and calls this SAME function
// (it already depends on `@aart/mcp`, architecture's three-clients
// principle) instead of maintaining its own local copy, so `aart bundle`/
// `aart push` (CLI) and `aart_deploy` (MCP) can never independently drift on
// "how does a human-typed --environment name resolve to a Deployment" or
// "how does a produced Bundle flatten to a files map."
// ---------------------------------------------------------------------------

function sanitizeBundleFilename(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}

/** Same on-disk layout as `@aart/server`'s own `writeBundleToDisk` (packages/server/src/bundle/bundle.ts) — see `resolveAndProduceBundle`'s own doc comment for why this package can't just call that function directly (it writes a real `Bundle` to disk; this returns `BundleLike`, an in-memory `{manifest, files}` map — both `ServerPort.produceBundle` and `BundlerPort.produceBundle` need the latter). */
function bundleToBundleLike(bundle: Bundle): BundleLike {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(bundle.manifest, null, 2),
    "triggers.json": JSON.stringify(bundle.triggers, null, 2),
  };
  for (const [key, workflow] of Object.entries(bundle.definitions)) {
    files[`definitions/${sanitizeBundleFilename(key)}.json`] = JSON.stringify(workflow, null, 2);
  }
  for (const [key, manifest] of Object.entries(bundle.packs)) {
    files[`packs/${sanitizeBundleFilename(key)}.json`] = JSON.stringify(manifest, null, 2);
  }
  for (const [key, entry] of Object.entries(bundle.registry.prompts)) {
    files[`registry/prompts/${sanitizeBundleFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  }
  for (const [key, entry] of Object.entries(bundle.registry.schemas)) {
    files[`registry/schemas/${sanitizeBundleFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  }
  return { manifest: bundle.manifest as unknown as Record<string, unknown>, files };
}

/**
 * Bridges a human-typed `--environment <name>` (`aart bundle`'s CLI flag,
 * or `aart push`'s remotes.json-resolved environment) to the real
 * `produceBundle`'s optional `Deployment` param. Throws only when the NAMED
 * environment itself doesn't exist — a real environment with no deployment
 * yet for this workflow/version is a legitimate "bare closure bundle"
 * request (matches `produceBundle`'s own documented optionality), not an
 * error.
 *
 * Remedy wording deliberately names BOTH the CLI and HTTP forms of ADR-2's
 * new `aart environment register`/`POST /environments` (this session,
 * AMENDMENTS.md A56) — this function is called from both CLI and MCP
 * callers, so a caller-agnostic remedy is correct here, unlike (e.g.)
 * `real-server-port.ts`'s own separate `resolveEnvironmentId` (a genuinely
 * CLI-only concern — `aart server --environment`'s own resolution — left
 * untouched, not part of this extraction).
 *
 * D1 fix pass (AMENDMENTS.md A57) — this SAME function backs `aart push`/
 * `aart_deploy`'s own environment resolution (`resolveAndProduceBundle`
 * below, called with `params.environment` set from the REMOTE's OWN
 * configured environment, `deployToRemoteHandler`'s doc comment). That
 * made this exact error a confusing, real first-push gotcha (tester
 * finding): it checks the CALLER's OWN store — by design, since the
 * caller's local `Deployment` for that environment is what carries the
 * `triggerConfig` the bundle ships with — but a first-time user who only
 * ever registered the environment on the REMOTE server (over SSH, or via
 * `POST /environments` against the remote) reads a bare "not found" here
 * with no hint that a SECOND, separate, LOCAL registration is what's
 * actually missing. The message now says both things explicitly.
 */
async function resolveDeploymentForEnvironmentName(store: AartStore, workflowId: string, workflowVersion: string, environmentName: string | undefined): Promise<Deployment | undefined> {
  if (!environmentName) return undefined;
  const environment = await store.environments.getByName(environmentName);
  if (!environment) {
    throw new Error(
      `Environment "${environmentName}" not found on THIS store (the one this command/tool is running against). Register it HERE first — "aart environment register ${environmentName} --trust-mode <dev|governed|strict|production>" (CLI), or POST /environments (HTTP) against this same store — then retry. This is a LOCAL requirement even for "aart push"/"aart_deploy": resolving "${environmentName}" here finds YOUR OWN Deployment for it, whose triggerConfig is what the bundle ships with — so it must exist on YOUR store, separately from (and in addition to) registering "${environmentName}" on the REMOTE server you may be pushing to, which is a different store entirely (see DEPLOY.md's "Environment registration" section).`,
    );
  }
  const deployments = await store.deployments.list({ environmentId: environment.id, workflowId });
  return deployments.find((d) => d.workflowVersion === workflowVersion);
}

/** The shared bridge itself — `BundlerPort.produceBundle`'s real implementation, and (imported into `@aart/cli`) `ServerPort.produceBundle`'s real implementation too. */
export async function resolveAndProduceBundle(store: AartStore, params: { workflowId: string; workflowVersion: string; environment?: string }): Promise<BundleLike> {
  const deployment = await resolveDeploymentForEnvironmentName(store, params.workflowId, params.workflowVersion, params.environment);
  const bundle = await produceRealBundle(store, { workflowId: params.workflowId, workflowVersion: params.workflowVersion, deployment, targetEnvironment: params.environment });
  return bundleToBundleLike(bundle);
}

export function createRealBundlerPort(store: AartStore): BundlerPort {
  return {
    produceBundle: (params) => resolveAndProduceBundle(store, params),
  };
}

/** See stubs/deploy.ts's own doc comment for why this is the exact same function as `createStubRemotesPort` — a plain JSON-file read has no expensive/non-deterministic "real thing" to fake, unlike every other port in this file. */
export const createRealRemotesPort: (root: string) => RemotesPort = createRemotesPort;
