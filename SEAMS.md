# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S5 MCP + CLI + model-native surface

### Pure-consumer status — no new interface published for a Wave-1 sibling to consume

S5 (`@aart/mcp`, `@aart/cli`) is the terminal, purely-downstream session in
the Wave-1 dependency graph (implementation plan §9/Appendix: S3/S5/S7 are
mutually unconstrained; nothing in Wave 1 depends on S5's exports). Every
export this session adds is either (a) internal to `@aart/mcp`/`@aart/cli`,
or (b) a documented STUB standing in for a real Wave-1 sibling's package
until S9 merge time — the reverse direction from what this file otherwise
logs. This entry is for **S9's benefit at merge time**: exactly which of
this session's modules need a real import swapped in, and the load-bearing
interpretive decisions made where neither source document gave an exact
shape — same protocol S0/S1/S2/S4/S6/S7 already used in this file/
AMENDMENTS.md for their own genuine gaps.

### Stub-swap points — what S9 should replace at merge

Every stub implements the EXACT signature its sibling's real, landed (or
documented) export uses — see each file's own module doc comment for the
verified source read. Swapping is a constructor-injection change in
`packages/mcp/src/context.ts`'s `createAartContext` (and
`packages/cli/src/cli-context.ts`'s `createCliContext` for the CLI-only
`ServerPort`), not a redesign:

| Port (`packages/mcp/src/types.ts`) | This session's stub | Real replacement at merge |
|---|---|---|
| `EnginePort` | `packages/mcp/src/stubs/engine.ts` (`createStubEngine`) | `@aart/engine`'s `createEngine(config)` (S1) |
| `GovernancePort` | `packages/mcp/src/stubs/governance.ts` (`createStubGovernance`) | `@aart/governance`'s real exports (S4 — already landed on branch `s4-governance`, worktree `/Users/johnlee/code/aart-s4`; verified against source 2026-07-10) |
| `EvidencePort` | `packages/mcp/src/stubs/evidence.ts` (`createStubEvidence`) | `@aart/evidence`'s `createReportRenderers`/correction-outcome functions (S6) |
| `RegistryPort` | `packages/mcp/src/stubs/registry.ts` (`createStubRegistry`) over `packages/mcp/src/catalog.ts`'s placeholder block catalog | `@aart/registry`'s real `findBlocks` (S7) fed the real `@aart/blocks-core` (S3) + pack-manifest catalog |
| `ServerPort` (CLI-only, `packages/cli/src/stubs/server.ts`) | `createStubServerPort` | `@aart/server`'s `startServer`/`startWorker`/`produceBundle`/`writeBundleToDisk`/`clearRunFlag`/`listFlaggedRuns` (S2) |

S4's governance stub is the ONE case where a real, landed implementation
already exists in a sibling worktree at the time this session ran —
`computeApprovalState`/`computePromotionState`/`evaluatePromotionForEnvironment`/
`REQUIRED_GATES_BY_MODE`/`AART_APPROVE_TOOL_NAME`/`MODES_WITH_AART_APPROVE`/
`isAartApproveRegisteredForMode` are mirrored **verbatim** (same algorithm,
same signature, copied from S4's actual `packages/governance/src/{approval,gates}.ts`).
`validateWorkflow`/`semanticRiskDiff`/`redact` are **simplified**
(schema-class-only validation; step-level-only diff, no capability-closure
risk-tier delta; no secondary-form [JSON-escaped/URL-encoded] redaction
matching) since full fidelity needs a real block catalog this worktree
doesn't have. See `packages/mcp/src/stubs/governance.ts`'s module doc
comment for the exact mirrored/simplified line, function by function.

### Load-bearing interpretive decisions (genuine gaps — neither source document gives an exact shape)

- **`aart_register_block` registers a WORKFLOW draft, not a block implementation.** Confirmed by architecture §10.2's own worked example ("Draft registered. Next: `aart_validate`.") and the v0.x prototype's identical-in-spirit `aa_register_block` ("Register. Call aa_register_block. It saves as draft.", `/Users/johnlee/code/aa-runtime/src/agent/guide.ts`). A registered workflow is additionally dispatchable as a `workflow`-type block from other workflows (S1 SEAMS.md Seam 6's uniform block-type dispatch), presumably the origin of the tool's literal name.
- **`ApprovalTask` has no `workflowId`/`workflowVersion` fields** (frozen shape: `runId`+`stepId` only; spec §23.4 confirms `ApprovalTask.status` is "a decision on ONE RUN's approval step"). But `aart_request_approval`/`aart_approve` also need to cover workflow-VERSION-level `humanReview`-gate approval (spec §17.5's whole authority matrix is framed around approving a workflow, not a running step). Resolved via a documented sentinel encoding — `runId: "version-review:<workflowId>@<workflowVersion>"`, `stepId: "humanReview"` — see `packages/mcp/src/handlers/governance.ts`'s module doc comment for the full reasoning. **Flag to S9/John:** if a cleaner mechanism emerges once S4's real approval-task flows are wired end to end, this sentinel convention should be revisited — it's this session's own fill for a genuine type-shape gap, not a frozen contract.
- **`aart_deploy_workflow`/`aart deploy` auto-creates the target `Environment`** (by name, empty config) if one doesn't already exist — nothing in this session's scope, or any sibling's documented seam, provides an environment-authoring surface, yet architecture §10.1's progressive-disclosure note ("register only once at least one Environment record exists") presumes one can come to exist. Per-environment required gates also reuse this session's `requiredGatesByMode` table (mode-based, not truly per-environment) — ADR-07 leaves a genuinely per-environment policy unspecified anywhere. See `packages/mcp/src/handlers/deployment.ts`'s module doc comment.
- **Four CLI commands beyond spec §33's literal bash-block list, each independently evidenced elsewhere in the source documents (not invented):** `aart bundle` (architecture §0.3/§1: "`aart bundle` ... is a `@aart/cli` command"); `aart flag clear`/`aart flag list` (architecture §13.3/A33: the CLI/dashboard-only exception to the three-client principle); `aart approve` (spec §17.5's authority matrix names CLI as an approval surface in EVERY trust mode — the only surface left once `aart_approve` is mode-gated out of MCP in strict/production, so without this command those two modes would have no approval path through anything this session builds); `aart mcp` (spec §27.2's own worked example, `npx @team-monet/aart mcp` — the exact command `aart init-agent`'s generated config invokes).
- **`@modelcontextprotocol/sdk`** (real, official MCP SDK, v1.29.0) is a genuine new external dependency of `@aart/mcp`, used only by the thin `mcp-stdio.ts` adapter (`aart mcp`'s actual runtime, wired to the real `npx @team-monet/aart mcp` entry point). Every mode-gating/envelope/dispatch behavior this session is graded on runs through protocol-agnostic `listTools()`/`callTool()` functions (`tools/server.ts`) with zero SDK involvement — the SDK adapter is a thin, separately-verified (typecheck/build, plus a light connect/close smoke test against fake stdio streams) wiring layer on top, not where the tested logic lives.

### Same-function-reference, structurally guaranteed

`packages/cli/src/commands/*.ts` import handler functions directly from
`@aart/mcp` (e.g. `authoring.ts` imports `runWorkflowHandler`/
`validateWorkflowHandler`/`registerWorkflowHandler`; `governance.ts` imports
`approveHandler`/`diffWorkflowHandler`/`promoteWorkflowHandler`/
`recordCorrectionHandler`; `evals.ts` imports `runEvalHandler`;
`deployment.ts` imports `deployWorkflowHandler`) and call them with zero
wrapping — the MCP tool and the CLI command dispatch to the literal same
function object. `packages/cli/src/index.ts` re-exports these same bindings
verbatim (not copies) specifically so S9's same-function-reference
integration check has something concrete to import and assert `===`
against, alongside `packages/cli/src/cli.test.ts`'s own direct comparison
test (`aart run` vs. calling `runWorkflowHandler` directly).

### For whoever builds the real `@aart/blocks-core` catalog (S3) or `@aart/registry` discovery index (S7)

`packages/mcp/src/catalog.ts`'s `BUILTIN_BLOCK_CATALOG` is a PLACEHOLDER (24
block manifests covering every block id spec §14.2's example and §32.5's
alias table name explicitly) — not a port of S3's real manifests. At merge,
`RegistryPort`'s real implementation should assemble its catalog from
`@aart/blocks-core`'s real manifests + `@aart/registry`'s pack-manifest-derived
blocks, per S7's own SEAMS.md (R2) note on this exact point.
