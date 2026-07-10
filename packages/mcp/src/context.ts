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
}

const VALID_TRUST_MODES: readonly TrustMode[] = ["dev", "governed", "strict", "production"];

/** spec §17.2's stated default: "Local development default: governed." Overridable via `AART_TRUST_MODE` or the explicit option. */
export function resolveTrustModeFromEnv(env: NodeJS.ProcessEnv = process.env): TrustMode {
  const raw = env.AART_TRUST_MODE;
  if (raw && (VALID_TRUST_MODES as readonly string[]).includes(raw)) return raw as TrustMode;
  return "governed";
}

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
