// Real block catalog + capability-closure lookup for this package's own
// data sources (S9 integration, reconciliation ledger item 13):
//   - the Blocks page (views/blocks-packs.ts) — real manifest listing.
//   - @aart/governance's semanticRiskDiff (stub-deps.ts) — real capability
//     closures for the risk-diff page.
// Mirrors packages/mcp/src/real-context.ts's buildCapabilityClosureLookup/
// buildRealCatalog, applied to this package rather than imported from
// @aart/mcp: architecture's three-client principle (§13.2) means
// CLI/MCP/dashboard call the SAME UNDERLYING functions (here,
// @aart/governance's real semanticRiskDiff/computeCapabilityClosure,
// @aart/blocks-core's real manifests) — it does not mean one client
// depends on another client's own composition-root code. @aart/mcp is a
// protocol-server package, not a shared library this package should
// import from.
//
// Both consumers only ever need each block's MANIFEST — never execute a
// block — so this deliberately builds the catalog with NO scorerRegistry/
// reportRenderers/LLM-provider config wired in (createBlockCatalog's own
// deps are optional; createLlmPack only needs `store` to construct,
// verified by reading both signatures directly rather than assumed).
//
// Same documented scope as real-context.ts's own catalog: only
// @aart/blocks-core + @aart/llm's core built-ins are included.
// Pack-delivered blocks are not (reconciliation ledger item 13's own
// tracked gap, shared with item 12's identical blocker — no
// pack-enumeration primitive exists on a fresh store; see this package's
// SEAMS.md/views/blocks-packs.ts for the Packs-page half of this, which
// stays a deliberately-pending page for that reason) — a workflow step
// referencing a pack-delivered block resolves as unresolved in the
// capability closure, same documented simplification real-context.ts's
// own lookup carries.
import { createBlockCatalog } from "@aart/blocks-core";
import { computeCapabilityClosure, type CapabilityClosureLookup, type CapabilityClosureNode, type CapabilityClosureResult } from "@aart/governance";
import { createLlmPack } from "@aart/llm";
import type { AartStore } from "@aart/store";
import type { BlockManifest, WorkflowStep } from "@aart/types";

function realBlockImplementations(store: AartStore) {
  const coreBlocks = createBlockCatalog();
  const llmBlocks = createLlmPack({ store }).blocks;
  return [...coreBlocks, ...llmBlocks];
}

/** The real core-builtin block catalog's manifests (56: 51 @aart/blocks-core + 5 @aart/llm) — what the Blocks page (views/blocks-packs.ts) renders. */
export function listBlockManifests(store: AartStore): BlockManifest[] {
  return realBlockImplementations(store).map((impl) => impl.manifest);
}

/** A single block's real manifest by id, for the Block detail page (views/blocks-packs.ts) — `undefined` if `id` isn't in the real catalog (same core-builtins-only scope as `listBlockManifests`, no pack-delivered blocks). */
export function getBlockManifest(store: AartStore, id: string): BlockManifest | undefined {
  return realBlockImplementations(store).find((impl) => impl.manifest.id === id)?.manifest;
}

export function buildCapabilityClosureLookup(store: AartStore): CapabilityClosureLookup {
  const capabilitiesById = new Map<string, readonly string[]>();
  for (const impl of realBlockImplementations(store)) {
    capabilitiesById.set(impl.manifest.id, impl.manifest.capabilities);
  }

  return {
    resolve(blockId: string): CapabilityClosureNode | undefined {
      const capabilities = capabilitiesById.get(blockId);
      if (!capabilities) return undefined;
      return { kind: "block", capabilities };
    },
  };
}

/** Computes both workflow versions' capability closures against the SAME lookup (the real semanticRiskDiff's own required input shape) — the one call site this package's real `semanticRiskDiff` wiring (stub-deps.ts) needs. */
export function closureFor(lookup: CapabilityClosureLookup, steps: readonly WorkflowStep[]): CapabilityClosureResult {
  return computeCapabilityClosure(steps, lookup);
}
