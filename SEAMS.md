# Seams

Protocol (implementation plan `aart_implementation_plan_v1.md` §7): distinct from `AMENDMENTS.md` (which is for *changing* an already-frozen interface). This file is for *new* interfaces being published early during Wave 1 — the moment a session defines something a sibling session will consume, even in draft form, even before that session's own package is otherwise finished, it gets an entry here. Named examples from the plan: S4's `redactRecord(record, resolvedSecretRefs)` signature (published early per S4's own DoD note); S1's `getDueWaits(now)` export for S2's ticker to call.

Consuming sessions check this file **before** proposing a shape themselves — "check `SEAMS.md`, then S0's frozen `@aart/types`/`@aart/expr`/`@aart/store`, then ask" is the intended order, never "propose and hope it converges."

Scaffolded empty by S0 (Wave 0 "Foundation") alongside `AMENDMENTS.md`. S0's own output is the frozen baseline every Wave-1 session starts from (`@aart/types`, `@aart/expr`, `@aart/store`'s interface — tagged `interfaces-frozen-v0`) — that baseline doesn't need entries here, since it isn't a mid-Wave-1 seam between two concurrent sessions, it's the starting line. The first real entries in this file will come from Wave 1.

---

## 2026-07-10 — S6 Evidence + reports + corrections + evals + familiarity-evals

### E1 — `LlmJudgeFn` — the seam `@aart/evidence`'s `llm_judge` scorer expects `@aart/llm` (S7) to satisfy

`@aart/llm` hasn't started (S7 is a concurrent Wave-1 session). `@aart/evidence`'s `llm_judge` `Scorer` kind (architecture §9.5/§12.3, spec §24.3's "clearly marked non-deterministic" kind) is built against a documented, stubbed boundary rather than a real `@aart/llm` import:

```ts
// packages/evidence/src/evals/scorers/llm-judge.ts
export interface LlmJudgeInput {
  model: string;            // provider/model convention, spec §13.6/§22.4
  actual: unknown;
  expected: unknown;
  criteria?: string;
  temperature?: number;     // always invoked at 0 by createLlmJudgeScorer, architecture §9.5
}
export interface LlmJudgeOutput {
  passed: boolean;
  score: number;
  detail?: string;
}
export type LlmJudgeFn = (input: LlmJudgeInput) => Promise<LlmJudgeOutput>;
```

`createScorerRegistry({ llmJudge?: LlmJudgeFn })` (registry.ts) wires this in — the `llm_judge` scorer kind throws a clear, descriptive error if invoked with no `llmJudge` supplied. **S7 should export a function from `@aart/llm` matching this shape** (its `llm.judge` block's underlying call, per architecture §12.3: "`llm.judge` — used both as a workflow step and, via `@aart/evidence`'s scorer registry, as the LLM-judge `Scorer` kind"). If S7's natural shape differs, reconcile via this file / the amendment protocol rather than `@aart/evidence` silently guessing again. `@aart/evidence`'s own tests use `createFakeLlmJudge` (same file) — a scripted fake, not a real model call.

### E2 — Scorer registry — consumed by `@aart/blocks-core`'s `eval.run`/`eval.score` blocks (S3)

```ts
// packages/evidence/src/evals/scorers/registry.ts
export function createScorerRegistry(options?: { llmJudge?: LlmJudgeFn }): ScorerRegistry;
interface ScorerRegistry {
  readonly kinds: readonly string[];             // the 12 BUILTIN_SCORER_KINDS from @aart/types
  get(kind: string): ScorerRegistryEntry | undefined;
  score(kind: string, actual: unknown, expected: unknown, config?: unknown): Promise<ScorerResult>;
}
```

S3's own DoD note ("Eval (2 — block-level `eval.run`/`eval.score` that call into S6's scorer registry, stubbed if S6 isn't done yet)") names this exact call point. S6 is done — S3 can import `createScorerRegistry`/`ScorerRegistry`/`ScorerResult` from `@aart/evidence` directly rather than stubbing. The 12 individual pure scorer functions (`exactMatch`, `jsonpathExact`, `jsonpathContains`, `regexScorer`, `numericTolerance`, `fieldLevelAccuracy`, `classificationMatch`, `artifactExists`, `screenshotExists`, `noConsoleErrors`, `customNode`) plus `createLlmJudgeScorer` are also individually exported from the same module, for a block that wants one scorer directly without the registry indirection.

### E3 — Report renderers — consumed by `@aart/dashboard` (S8) and `@aart/blocks-core`'s `report.*` blocks (S3)

```ts
// packages/evidence/src/renderers/index.ts
export function createReportRenderers(redact: RedactFn): {
  modelFacing(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): ModelFacingReport;
  markdown(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  html(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  prComment(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>, options?: PrCommentOptions): string;
  json(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
  cliText(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): string;
};
```

`html`'s output is what architecture §9.1 says serves spec §19.3's "dashboard view" format — S8 should render this directly rather than re-implementing a RunRecord→HTML transform. `redact: RedactFn` is S4's real `redactRecord` once published (see AMENDMENTS/S4's own seam note); wire it in once at the composition root, not per render call.

### E4 — Correction-outcome functions — writable actions consumed by `@aart/dashboard` (S8)

Architecture §13.2: "every writable action in the dashboard calls the SAME underlying functions the MCP/CLI surfaces call... the dashboard is a third client of those functions, not a parallel implementation." These are that function set (`packages/evidence/src/corrections/outcomes.ts` and `correction.ts`), all `(store: AartStore, ...) => Promise<...>`:

```ts
recordCorrection(store, input: RecordCorrectionInput): Promise<Correction>          // capture (correction.ts)
updateRunOutput(store, correction: Correction): Promise<RunRecord>                  // outcome 1/6
createEvalExampleFromCorrection(store, correction, suiteId, options?): Promise<EvalExample>  // outcome 2/6
createIssueForAgent(store, correction: Correction): Promise<ImprovementBrief>       // outcome 3/6
triggerImprovementProposal(store, workflowId, workflowVersion, options?): Promise<ImprovementBrief>  // outcome 4/6
blockPromotion(store, workflowId, workflowVersion): Promise<Workflow>               // outcome 5/6
unblockPromotion(store, workflowId, workflowVersion): Promise<Workflow>             // complement, not one of the 6
markNeedsReview(store, workflowId, workflowVersion): Promise<Workflow>              // outcome 6/6
clearNeedsReview(store, workflowId, workflowVersion): Promise<Workflow>             // complement, not one of the 6
```

S8's dashboard "record correction / create eval / promote / view risk diff" actions (architecture §13.2's writable v2 list) should call these directly, not reimplement store writes. Same applies to whichever session builds `aart_record_correction` (MCP, §34) / `aart correction add` (CLI, §33.3) if that hasn't landed elsewhere yet.

### E5 — `ValidateFn` / `RunSuccessFn` — the seams `@aart/familiarity-evals` expects the REAL `aart_validate` (S4) and engine-backed run success (S1) to satisfy

`@aart/familiarity-evals` is deliberately fully offline-testable (this session's DoD) and does not depend on `@aart/governance` or `@aart/engine` (neither has landed; a familiarity-eval gate depending on either would also be a layering inversion — familiarity-evals is a CI-gate consumer of AART's own surface, not something governance/engine should need to know about). It ships its own small reference implementations for its own tests only:

```ts
// packages/familiarity-evals/src/types.ts
export type ValidateFn = (workflow: unknown) => ValidateResult | Promise<ValidateResult>;
export type RunSuccessFn = (workflow: unknown) => RunSuccessResult | Promise<RunSuccessResult>;
```

`validate.ts`'s `createReferenceValidator(knownBlocks)` covers only spec §18.1 (schema validation) + a structural stand-in for §18.2 (block-reference validation) — it does NOT implement capability/input-safety/deployment validation (§18.3-18.5), which need governance's real policy model. `run-success.ts`'s `createReferenceRunSuccessChecker()` is schema-shape-only (parses + has ≥1 step), not a real execution. **This session's DoD explicitly does not wire CI or run a real-model baseline — that's S9's job** (implementation plan §3/S6 DoD note): S9 should inject governance's real validator and an engine-backed run-success check via these same two function-type seams when it wires the familiarity-evals CI gate (ADR-15's "own CI wiring, separate from a workflow's own promotion-gate CI... triggered by PRs to the `aart` repo itself").

### E6 — Dry-run + connector-fake vocabulary (documented convention, not a function seam)

`@aart/evidence`'s `evals/dry-run.ts` (`ConnectorFakeRegistry`, `isEffectfulCapability`, `DEFAULT_EFFECTFUL_CAPABILITIES = ["email.send", "command", "db.write"]` plus the `domain:<pattern>` family) is `@aart/evidence`'s OWN self-contained implementation of architecture §9.5's dry-run/connector-fake mechanism, scoped to running an eval suite's fixture steps — it does not depend on `@aart/engine` and `@aart/engine` does not depend on it. `@aart/engine`'s REAL dry-run check (architecture §9.5 point 1: `RunRecord.params.dryRun` checked at the dispatch boundary, architecture §4.2) is S1's separate responsibility. The two are meant to converge on the same VOCABULARY (a `dryRun` boolean, the same effectful-capability set, "fake ships alongside real under the same block name") by documented contract, not shared code. **Flagging this for S1/S9's awareness**: if S1's real effectful-capability set diverges from `DEFAULT_EFFECTFUL_CAPABILITIES` above, that's fine (it's a caller-overridable default, not a frozen enum) but worth reconciling explicitly during S9's integration pass so a workflow author's mental model of "what counts as effectful" doesn't differ between an eval dry-run and a real `RunRecord.params.dryRun` run.
