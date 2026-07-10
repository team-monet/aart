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
import { createFsStore, type AartStore } from "@aart/store";
import type { TrustMode } from "@aart/types";
import { BUILTIN_BLOCK_CATALOG } from "./catalog.js";
import { buildRealCatalog, createRealEnginePort, createRealEvidencePort, createRealGovernancePort, createRealRegistryPort, createRealEngine, type RealCatalogLlmOptions } from "./real-context.js";
import { createStubEngine } from "./stubs/engine.js";
import { createStubEvidence } from "./stubs/evidence.js";
import { createStubGovernance } from "./stubs/governance.js";
import { createStubRegistry } from "./stubs/registry.js";
import type { EnginePort, EvidencePort, GovernancePort, RegistryPort } from "./types.js";

export interface AartContext {
  store: AartStore;
  engine: EnginePort;
  governance: GovernancePort;
  evidence: EvidencePort;
  registry: RegistryPort;
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
  const store = options.store ?? createFsStore(options.root ?? path.join(process.cwd(), ".aart"));
  const governance = options.governance ?? createStubGovernance();
  const engine = options.engine ?? createStubEngine(store, now);
  const evidence = options.evidence ?? createStubEvidence(store, engine);
  const registry = options.registry ?? createStubRegistry(BUILTIN_BLOCK_CATALOG);
  const trustMode = options.trustMode ?? resolveTrustModeFromEnv();
  return { store, engine, governance, evidence, registry, trustMode, now };
}

/**
 * The REAL composition root (S9 integration, reconciliation ledger items
 * 3/4/5/11) — every port bound to its real, now-merged sibling package
 * implementation (`real-context.ts`): `@aart/engine`'s real `createEngine`
 * fed the real 56-block catalog (`@aart/blocks-core` + `@aart/llm`), real
 * `@aart/governance` policy functions, real `@aart/evidence` reports/
 * corrections/eval-running, real `@aart/registry` block search. This is
 * what production entry points and this session's own flagship E2E tests
 * (`examples/redacted-legacy-b`, `examples/redacted-legacy-a`) exercise — an
 * `options.engine`/`governance`/`evidence`/`registry` override still works
 * (an E2E test that wants to override just one piece can), matching
 * `createAartContext`'s own override discipline.
 */
export function createRealAartContext(options: CreateAartContextOptions = {}): AartContext {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? createFsStore(options.root ?? path.join(process.cwd(), ".aart"));
  const trustMode = options.trustMode ?? resolveTrustModeFromEnv();

  // Built once, shared by whichever of engine/governance/evidence/registry
  // actually need it below — real catalog assembly (@aart/blocks-core +
  // @aart/llm) and the real Engine instance are each real work (constructs
  // provider adapters, assembles 56 block manifests), not free, so this
  // only happens when at least one port isn't explicitly overridden.
  const needsRealCatalog = !options.engine || !options.governance || !options.evidence || !options.registry;
  const catalog = needsRealCatalog ? buildRealCatalog(store, options.llm) : undefined;
  const realEngine = !options.engine || !options.evidence ? createRealEngine(store, catalog!.blocks) : undefined;

  const governance = options.governance ?? createRealGovernancePort(catalog!.blocks, trustMode);
  const engine = options.engine ?? createRealEnginePort(realEngine!);
  const evidence = options.evidence ?? createRealEvidencePort(store, realEngine!);
  const registry = options.registry ?? createRealRegistryPort(catalog!.entries);
  return { store, engine, governance, evidence, registry, trustMode, now };
}
