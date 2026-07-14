// createAartContext — the ONE composition root both @aart/mcp's tool
// handlers and @aart/cli's commands are built against (architecture's
// three-clients principle: CLI/MCP/dashboard call the SAME underlying
// functions, never parallel implementations). @aart/cli imports this
// function directly rather than re-deriving its own wiring, which is what
// structurally guarantees "aart approve" (CLI) and "aart_approve" (MCP) —
// or "aart promote" and "aart_promote_workflow", etc. — dispatch to the
// literal same handler function object (S9's same-function-reference check,
// per this session's own hard rules).
import path from "node:path";
import type { Engine } from "@aart/engine";
import { createFsStore, type AartStore } from "@aart/store";
import type { TrustMode } from "@aart/types";
import { BUILTIN_BLOCK_CATALOG } from "./catalog.js";
import { buildRealCatalog, createRealBundlerPort, createRealEnginePort, createRealEvidencePort, createRealGovernancePort, createRealRegistryPort, createRealRemotesPort, createRealEngine, type RealCatalogLlmOptions } from "./real-context.js";
import { createStubBundlerPort, createStubRemotesPort } from "./stubs/deploy.js";
import { createStubEngine } from "./stubs/engine.js";
import { createStubEvidence } from "./stubs/evidence.js";
import { createStubGovernance } from "./stubs/governance.js";
import { createStubRegistry } from "./stubs/registry.js";
import type { BundlerPort, EnginePort, EvidencePort, GovernancePort, RegistryPort, RemotesPort } from "./types.js";

export interface AartContext {
  store: AartStore;
  engine: EnginePort;
  governance: GovernancePort;
  evidence: EvidencePort;
  registry: RegistryPort;
  /** D1 "remotes + push" (AMENDMENTS.md A56) — see types.ts's own BundlerPort/RemotesPort doc comment for why these two live directly on AartContext rather than being CLI-only like ServerPort. */
  bundler: BundlerPort;
  remotes: RemotesPort;
  trustMode: TrustMode;
  now: () => Date;
}

export interface CreateAartContextOptions {
  /** `.aart` directory root for the fs store. Defaults to `<cwd>/.aart`. Ignored if `store` is supplied. */
  root?: string;
  store?: AartStore;
  engine?: EnginePort;
  governance?: GovernancePort;
  evidence?: EvidencePort;
  registry?: RegistryPort;
  bundler?: BundlerPort;
  remotes?: RemotesPort;
  trustMode?: TrustMode;
  now?: () => Date;
  /** `createRealAartContext` only (ignored by `createAartContext`, which never constructs a real `@aart/llm` pack) — passthrough to `buildRealCatalog`'s own `RealCatalogLlmOptions` (real-context.ts), for injecting a fake provider client/fetcher in tests that need the REAL llm.extract/llm.classify block dispatch without a real API key. */
  llm?: RealCatalogLlmOptions;
}

const VALID_TRUST_MODES: readonly TrustMode[] = ["dev", "governed", "strict", "production"];

/** spec §17.2's stated default: "Local development default: governed." Overridable via `AART_TRUST_MODE` or the explicit option. */
export function resolveTrustModeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustMode {
  const raw = env.AART_TRUST_MODE;
  if (raw && (VALID_TRUST_MODES as readonly string[]).includes(raw)) return raw as TrustMode;
  return "governed";
}

/**
 * The STUB-bound context (unchanged default) — deliberately kept as the
 * default here, even after S9 integration built real implementations for
 * every port (`real-context.ts`, reconciliation ledger items 3/4/5/11).
 * This package's own test suite (and CLI's) is built extensively against
 * the stub engine's fast, deterministic, no-real-browser/no-real-LLM-call
 * simulated semantics (`stubs/engine.ts`'s own doc comment: "every other
 * step 'completes' immediately with empty outputs") — verified directly
 * during this integration pass: flipping this default to the real
 * implementations broke 5 existing handler/tool tests (real governance
 * validation/capability/approval semantics genuinely differ from the
 * stub's simplified ones, and `sampleWorkflowYaml`'s `browser.goto`/
 * `web.read` steps would launch a REAL headless browser under the real
 * engine). That is proper test hygiene, not a gap to silently paper over
 * by rewriting the whole suite's fixtures mid-integration-pass — unit
 * tests for individual handlers should stay fast/deterministic/offline;
 * exercising the REAL stack end-to-end is what `createRealAartContext`
 * below and this session's flagship E2E tests are for. Production entry
 * points (`@aart/cli`'s `bin.ts`, `@aart/mcp`'s `mcp-stdio.ts`) call
 * `createRealAartContext` instead of this function.
 */
export function createAartContext(options: CreateAartContextOptions = {}): AartContext {
  const now = options.now ?? (() => new Date());
  const resolvedRoot = options.root ?? path.join(process.cwd(), ".aart");
  const store = options.store ?? createFsStore(resolvedRoot);
  const governance = options.governance ?? createStubGovernance();
  const engine = options.engine ?? createStubEngine(store, now);
  const evidence = options.evidence ?? createStubEvidence(store, engine);
  const registry = options.registry ?? createStubRegistry(BUILTIN_BLOCK_CATALOG);
  const bundler = options.bundler ?? createStubBundlerPort(store);
  const remotes = options.remotes ?? createStubRemotesPort(resolvedRoot);
  const trustMode = options.trustMode ?? resolveTrustModeFromEnv();
  return { store, engine, governance, evidence, registry, bundler, remotes, trustMode, now };
}

export interface RealAartContextResult {
  context: AartContext;
  /**
   * The raw `@aart/engine` `Engine` instance backing `context.engine`
   * (`EnginePort`), when this call actually constructed one — `undefined`
   * only if the caller overrode BOTH `options.engine` and `options.evidence`
   * (the two ports that would otherwise need it), leaving nothing for this
   * function to build. Exists so a caller that needs more of the real
   * engine than `EnginePort` exposes — `@aart/cli`'s composition root,
   * which feeds this same instance into `@aart/server`'s
   * `createRealEngineBoundary` for `startServer`/`startWorker` (AMENDMENTS.md
   * A42) — can reuse the exact same Engine `createRealAartContext` already
   * built, rather than constructing a second, divergent one over the same
   * store.
   */
  engine: Engine | undefined;
}

/**
 * The REAL composition root (S9 integration, reconciliation ledger items
 * 3/4/5/11) — every port bound to its real, now-merged sibling package
 * implementation (`real-context.ts`): `@aart/engine`'s real `createEngine`
 * fed the real 56-block catalog (`@aart/blocks-core` + `@aart/llm`), real
 * `@aart/governance` policy functions, real `@aart/evidence` reports/
 * corrections/eval-running, real `@aart/registry` block search. This is
 * what production entry points and this session's own flagship E2E tests
 * (`review-cycle`/`item-review`, `packages/mcp/src/e2e/`) exercise — an
 * `options.engine`/`governance`/`evidence`/`registry` override still works
 * (an E2E test that wants to override just one piece can), matching
 * `createAartContext`'s own override discipline.
 *
 * Returns both the `AartContext` and the raw `Engine` (when one was built)
 * — see `RealAartContextResult`'s own doc comment for why. `createRealAartContext`
 * below is the pre-existing, unchanged-behavior convenience wrapper for
 * every caller that only wants the context.
 */
export function createRealAartContextWithEngine(options: CreateAartContextOptions = {}): RealAartContextResult {
  const now = options.now ?? (() => new Date());
  const resolvedRoot = options.root ?? path.join(process.cwd(), ".aart");
  const store = options.store ?? createFsStore(resolvedRoot);
  const trustMode = options.trustMode ?? resolveTrustModeFromEnv();

  // Built once, shared by whichever of engine/governance/evidence/registry
  // actually need it below — real catalog assembly (@aart/blocks-core +
  // @aart/llm) and the real Engine instance are each real work (constructs
  // provider adapters, assembles 56 block manifests), not free, so this
  // only happens when at least one port isn't explicitly overridden.
  const needsRealCatalog = !options.engine || !options.governance || !options.evidence || !options.registry;
  const catalog = needsRealCatalog ? buildRealCatalog(store, options.llm) : undefined;
  // trustMode threaded through explicitly (AMENDMENTS.md, S15) — this is
  // what makes the real capability-dispatch chokepoint (architecture §4.6,
  // via createGetGrantedCapabilities) agree with the SAME trustMode this
  // context records onto RunRecord.approvalMode below, instead of the two
  // silently diverging whenever a run carries no `environment` (the S11/A42
  // finding this session settles).
  const realEngine = !options.engine || !options.evidence ? createRealEngine(store, catalog!.blocks, trustMode) : undefined;

  const governance = options.governance ?? createRealGovernancePort(catalog!.blocks, trustMode);
  const engine = options.engine ?? createRealEnginePort(realEngine!);
  const evidence = options.evidence ?? createRealEvidencePort(store, realEngine!);
  const registry = options.registry ?? createRealRegistryPort(catalog!.entries);
  const bundler = options.bundler ?? createRealBundlerPort(store);
  const remotes = options.remotes ?? createRealRemotesPort(resolvedRoot);
  return { context: { store, engine, governance, evidence, registry, bundler, remotes, trustMode, now }, engine: realEngine };
}

/** Convenience wrapper over `createRealAartContextWithEngine` for every caller that only needs the `AartContext` (unchanged signature/behavior from before that function existed). */
export function createRealAartContext(options: CreateAartContextOptions = {}): AartContext {
  return createRealAartContextWithEngine(options).context;
}
