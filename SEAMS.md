# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S7 Registry + packs distribution + llm pack

### R1 — Registry → governance pack-seal convergence point (architecture §11.1/§16.2, consumed by S4)

`@aart/registry` (this package) owns computing/recomputing a pack's content hash; `@aart/governance` (S4) owns the seal-broken DECISION on top of it (`isPackSealBroken`, `packages/governance/src/pack-approval.ts`, already landed on S4's branch — read via the sibling worktree, not a real dependency of this package). The division, made concrete:

```ts
// @aart/registry (this package, packages/registry/src/manifest.ts)
function buildPackManifest(raw: RawPackManifest, blockSources: Record<string, string>): PackManifest
// approvalStatus is HARDCODED "unapproved" — no parameter can set it otherwise.

function recomputePackManifest(existing: Pick<PackManifest, "approvalStatus">, raw: RawPackManifest, blockSources: Record<string, string>): PackManifest
// Re-derives contentHash from CURRENT (manifest, blockSources) — this is
// the "current" side of S4's seal-broken comparison. PRESERVES
// existing.approvalStatus (does not itself decide anything).

// @aart/governance (S4, already landed)
function isPackSealBroken(approvedSnapshot: Pick<PackManifest, "contentHash">, current: Pick<PackManifest, "contentHash">): boolean
// true iff approvedSnapshot.contentHash !== current.contentHash.
```

**The convergence S9 should verify at merge:** `recomputePackManifest(...).contentHash` (this package, run against a pack's CURRENT on-disk manifest+blocks) is the correct "current" argument to feed `isPackSealBroken` (S4's package) alongside the `PackManifest` row last written at approval time. Neither function calls the other — this package has zero dependency on `@aart/governance` (which is a stub in this worktree); the two converge purely on the shared `PackManifest.contentHash` field and the shared hash algorithm (SHA-256 over canonicalized-JSON `{ manifest, blocks: [{name, source}, ...] }`, sorted by block id — `packages/registry/src/hash.ts`). If S4's real seal-check ever needs registry to expose a combined "load + recompute + compare" convenience instead of two separate calls, that's a small additive function this package can add without any existing caller breaking.

**No-weaker-approval-path invariant, structurally enforced:** `buildPackManifest` is the ONLY constructor of a `PackManifest`, called by both `authorPack` (workspace-authored) and `installPack` (npm-distributed, ADR-12) in `packages/registry/src/import.ts` — neither caller, nor `buildPackManifest` itself, exposes an `approvalStatus`/`approved` parameter anywhere. Approving a pack is exclusively S4's `writePackApprovalDecision`, a distinct package, a distinct write path, over the same `store.packManifests` row. Tested directly in `import.test.ts` ("an imported pack and a workspace-authored pack land in IDENTICAL unapproved states — spec §44.2").

### R2 — `findBlocks` / `BlockCatalogEntry` — the seam `@aart/mcp`'s `aart_find_blocks` tool (S5) should call into

Neither source document gives `aart_find_blocks` a literal TS signature (architecture §11.4/spec §44.3 name it only in prose). This package's fill, `packages/registry/src/discovery.ts`:

```ts
export interface BlockCatalogEntry {
  manifest: BlockManifest;   // @aart/types, unmodified — no amendment made
  packName?: string;         // undefined = core built-in, set = pack-delivered
  examples: readonly Example[]; // @aart/types' Example, reused — see note below
}
export function findBlocks(input: { query: string; scope: "local" | "remote"; localCatalog?: readonly BlockCatalogEntry[]; remoteIndex?: readonly RemoteRegistryIndexEntry[] }): BlockSearchResult[]
```

**Design note (considered and rejected: amending `@aart/types`):** spec §44.3 wants per-block `Example[]` in search results, but the frozen `BlockManifest` (`@aart/types`, architecture §2.5) has no `examples` field — only `Workflow` does. Rather than widen the S0-frozen type for a need that's local to how discovery SHAPES its results, `BlockCatalogEntry` composes `BlockManifest` + `examples` locally, in this package only. No `@aart/types` file was touched; no `AMENDMENTS.md` entry was needed for this. `@aart/mcp` (S5) — whoever assembles the actual local catalog (core `@aart/blocks-core` manifests + this package's `store.packManifests`-derived pack blocks) and the remote static index — should build `BlockCatalogEntry[]` the same way and call `findBlocks` rather than re-implementing search.

### R3 — LLM prompt/schema registry resolution result — the seam S1's `ExecutionSnapshot` capture should consume

See `packages/llm/SEAMS.md`-equivalent entry below (L1) — published here too since it's the other named S9 coordination point from this session's brief.

---

## 2026-07-10 — S7 LLM pack

### L1 — Prompt/schema registry resolution result → `ExecutionSnapshot.resolvedVersions` (architecture §4.5/§12.2, consumed by S1)

`@aart/llm`'s `resolvePromptRef`/`resolveSchemaRef` (`packages/llm/src/registry.ts`) resolve a workflow-authored `prompts.<name>` / `schemas.<name>` reference against `store.promptRegistry`/`store.schemaRegistry`, **lazily** — only when an `llm.*` block's `execute()` actually runs (never at workflow parse/run-start; see `registry.test.ts`'s "laziness" describe block for the exact test). Each resolution returns:

```ts
interface PromptResolution { ref: string; name: string; version: string; contentHash: string; body: string }
interface SchemaResolution { ref: string; name: string; version: string; contentHash: string; jsonSchema: unknown }
```

Architecture §4.5/§12.2 requires the resolved **(name, version, contentHash) triple** to be "pinned into `ExecutionSnapshot.resolvedVersions`" — but that field's frozen shape (`@aart/types`, `run.ts`) is `Record<string, string>` (one string value per key), which can't literally hold a 3-tuple. This package's resolution: key = the ref exactly as written in the workflow (e.g. `"prompts.energy_bill_extraction"`), value = `` `${version}+${contentHash}` `` (contentHash is always formatted `sha256:<hex>`, which contains no `+`, so splitting on the first `+` is unambiguous). Published helpers for S1 to use verbatim rather than re-deriving the convention:

```ts
// packages/llm/src/registry.ts
export function encodeResolvedVersion(r: Pick<PromptResolution | SchemaResolution, "version" | "contentHash">): string
export function decodeResolvedVersion(value: string): { version: string; contentHash: string }
```

**What S1 should do when it wires real `ExecutionSnapshot` capture:** for every `llm.*` step in the run's trace that resolved a prompt/schema, call `resolvedVersions[resolution.ref] = encodeResolvedVersion(resolution)`. If S1's actual capture mechanism wants a different encoding (e.g. it turns out something downstream needs `version` queryable without decoding), that's a small, easy change on this package's side — flag it here rather than S1 silently inventing a second convention.

### L2 — `LlmJudgeFn` — this package's answer to S6's `SEAMS.md` entry E1

S6 (evidence) documented the exact shape its `llm_judge` `Scorer` kind needs (`/Users/johnlee/code/aart-s6/SEAMS.md`, entry E1) before `@aart/llm` existed. This package adopts that shape **verbatim, field-for-field** — not merely "reconcilable," structurally identical:

```ts
// packages/llm/src/blocks/judge.ts — matches S6's documented LlmJudgeInput/LlmJudgeOutput/LlmJudgeFn exactly
export interface LlmJudgeInput { model: string; actual: unknown; expected: unknown; criteria?: string; temperature?: number }
export interface LlmJudgeOutput { passed: boolean; score: number; detail?: string }
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;
export function createLlmJudge(deps: LlmJudgeDeps): LlmJudgeFn
```

`createLlmJudge(deps)` is what `@aart/evidence`'s `createScorerRegistry({ llmJudge })` (S6's E1) should be wired with at the composition root once both packages are real (today, S6 tests its own scorer registry against `createFakeLlmJudge`, per E1). Since `@aart/evidence` is a stub in this worktree, this package cannot import S6's actual `LlmJudgeFn` type to structurally guarantee assignability at compile time — the two are independently declared, field-for-field identical by inspection (this file vs. S6's E1 text) as of 2026-07-10. **S9 should add a compile-time check at merge** (e.g. a one-line `const _check: import("@aart/evidence").LlmJudgeFn = createLlmJudge(fakeDeps)` in an integration test) to catch silent drift if either side's shape moves before merge. No divergence found as of this writing — flagging the verification step, not a known mismatch.

### L3 — `llm.*` block output convention — a proposed `BlockExecutionContext` extension for S1

The frozen `BlockImplementation.execute: (resolvedInputs, ctx) => Promise<unknown>` (`@aart/types`, architecture §2.5) returns exactly one value, consumed as the step's `outputs` (spec §22.1's own example shows `{{ steps.parse_bill.outputs.text }}` — a step's resolved output must stay a PLAIN value, not wrapped). But `StepTrace.llmCall: LlmCallMetadata` (architecture §19.2) also needs populating from that same call, out-of-band from the plain output. Architecture §2.5 explicitly anticipates `BlockExecutionContext` will be extended by S1 ("its exact shape is S1's to specify... a shape-changing extension by S1 is exactly the kind of post-freeze change the amendment protocol covers"). This package's `llm.*` blocks (`packages/llm/src/blocks/*.ts`) therefore:

1. Return the plain resolved output from `execute()` — correct `{{ steps.X.outputs.field }}` ergonomics, matching every other block.
2. Call `ctx.recordLlmCall?.(metadata)` — an OPTIONAL, defensively-invoked extension point this package proposes but does not require: `interface LlmBlockExecutionContext extends BlockExecutionContext { recordLlmCall(metadata: LlmCallMetadata): void }`. Against a bare `BlockExecutionContext` (e.g. this package's own tests, or an engine that hasn't added this method yet), the optional-chained call is simply a no-op — the block still executes and returns the correct output, it just has nowhere to hand the metadata.

Each block's CORE logic (`llmCall`, `llmExtract`, `llmClassify`, `llmGenerate`, the judge core) is independently exported and directly returns `{ output, llmCallMetadata }` — fully testable (and tested) without any `BlockExecutionContext` at all, which is how this session verified "`LlmCallMetadata` is populated correctly regardless of which provider handled the call" per its own DoD without needing the engine to exist first. **S1: if `recordLlmCall` isn't the shape you want, this is a proposal, not a fait accompli** — the core functions don't depend on it existing at all, so changing/renaming/reshaping it costs this package nothing beyond updating the thin `execute()` adapters.

---
