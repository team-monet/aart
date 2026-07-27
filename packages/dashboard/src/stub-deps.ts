// createStubDeps — the default DashboardDeps implementation this package's
// own tests and any local/dev run use until the remaining Wave-1 siblings'
// composition-root wiring lands (evidence/engine — reconciliation ledger
// items 3/5). Every function here matches its sibling's documented
// signature EXACTLY (see deps.ts's per-group citations) so each remaining
// swap is a value replacement, never a call-site rewrite.
//
// S9 integration (reconciliation ledger item 2): the promotion group
// (computeApprovalState/evaluatePromotionForEnvironment/
// REQUIRED_GATES_BY_TRUST_MODE/promoteWorkflowVersionToEnvironment) is no
// longer this package's own mirror — bound directly to @aart/governance's
// and @aart/server's real, now-merged exports below. This is the first of
// several groups in this file to make that swap.
//
// S9 integration (reconciliation ledger item 13): semanticRiskDiff joins
// that real-bound group below — @aart/governance's real risk-diff
// algorithm, fed a real capability-closure lookup built from
// @aart/blocks-core + @aart/llm's actual manifests (capability-catalog.ts,
// mirroring but NOT importing packages/mcp/src/real-context.ts's own
// identically-shaped lookup — see that file's doc comment for why each
// client builds its own rather than one client depending on another's
// composition root). This package's former computeSimpleStepDiff
// (the now-deleted views/workflows.ts) is deleted, not kept alongside —
// its own doc comment already called itself "a deliberately SIMPLIFIED
// stand-in... until the real capability-closure-based diff can be wired in."
//
// Still local mirrors (unrelated reconciliation items — evidence's report
// renderers/scorer registry/runEvalSuite, engine's triggerRun/
// resumeApproval) until their own composition-root wiring lands in this
// package specifically (note: the ENGINE/EVIDENCE wiring itself already
// landed for @aart/mcp's composition root, real-context.ts — this
// package has its own separate DashboardDeps container per architecture's
// three-client principle, so that wiring doesn't automatically reach here;
// tracked as a distinct, not-yet-done follow-up, not silently assumed
// resolved).
import type { AartStore } from "@aart/store";
import type { ApprovalTask, Correction, EvalExample, EvalRun, EvalSuite, ImprovementBrief, RunRecord, Scorer, StepTrace, Workflow } from "@aart/types";
import { computeApprovalState, evaluatePromotionForEnvironment, REQUIRED_GATES_BY_MODE, semanticRiskDiff as governanceSemanticRiskDiff } from "@aart/governance";
import { promoteWorkflowVersionToEnvironment } from "@aart/server";
import { buildCapabilityClosureLookup, closureFor } from "./capability-catalog.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import { escapeHtml } from "./http/html.js";
import { generateId } from "./ids.js";
import type { ClearRunFlagResult, DashboardDeps, GateName, ReportRenderers, ResumeOutcome, ScorerRegistry, ScorerResult, SemanticRiskDiffFn, TriggerRunInput } from "./deps.js";

export { computeApprovalState, evaluatePromotionForEnvironment, promoteWorkflowVersionToEnvironment };

/** Real semanticRiskDiff, bound to a fresh capability-closure lookup built from `store`'s available block catalog (capability-catalog.ts). A fresh lookup per call (not cached at `createStubDeps` construction time) — this package's block catalog is process-static today (no pack-delivered blocks are foldable in yet, item 13's documented gap shared with item 12's), so caching would be a safe micro-optimization, but computing it fresh keeps this function trivially correct if/when that stops being true, and `createBlockCatalog()`/`createLlmPack` are both cheap, pure, in-memory constructions (no I/O). */
export function makeSemanticRiskDiff(store: AartStore): SemanticRiskDiffFn {
  const lookup = buildCapabilityClosureLookup(store);
  return function semanticRiskDiff(from: Workflow, to: Workflow) {
    return governanceSemanticRiskDiff(
      { steps: from.execution.steps, capabilityClosure: closureFor(lookup, from.execution.steps) },
      { steps: to.execution.steps, capabilityClosure: closureFor(lookup, to.execution.steps) },
    );
  };
}
/** @deprecated kept as an alias during S9 integration in case any external caller imported this package's former locally-named constant directly; use `REQUIRED_GATES_BY_MODE` (re-exported from `@aart/governance` via this module) going forward. */
export const REQUIRED_GATES_BY_TRUST_MODE = REQUIRED_GATES_BY_MODE;
export { REQUIRED_GATES_BY_MODE };

// ---------------------------------------------------------------------------
// S2 seam — mirrors packages/server/src/flags.ts's clearRunFlag/
// listFlaggedRuns exactly (read from the S2 sibling worktree during this
// session's research): clearing sets clearedBy/clearedAt on the EXISTING
// flag record rather than deleting it (preserves audit trail); run.status
// is left unchanged.
// ---------------------------------------------------------------------------

export function makeClearRunFlag(clock: Clock = systemClock) {
  return async function clearRunFlag(store: AartStore, runId: string, clearedBy: string): Promise<ClearRunFlagResult> {
    const run = await store.runs.get(runId);
    if (!run) return { kind: "not_found" };
    if (!run.flag || run.flag.clearedAt) return { kind: "no_flag" };
    const updated: RunRecord = { ...run, flag: { ...run.flag, clearedBy, clearedAt: clock.nowIso() } };
    await store.runs.put(updated);
    return { kind: "cleared", run: updated };
  };
}

export async function listFlaggedRuns(store: AartStore): Promise<RunRecord[]> {
  const failed = await store.runs.list({ status: "failed" });
  return failed.filter((r) => r.flag && !r.flag.clearedAt);
}

// ---------------------------------------------------------------------------
// S1 seam — a minimal but structurally correct triggerRun: builds a
// "pending" RunRecord and enqueues it, matching Seam 3's documented
// contract ("does NOT persist the Workflow itself"; "enqueues onto
// AartStore.jobQueue itself"). No concurrency-policy resolution (this
// worktree's Workflow type has no `concurrency` field — S1's own A16
// amendment adding it is NOT in this worktree's @aart/types, per this
// session's frozen-surface heads-up; see SEAMS.md/report) and no real step
// execution (that's the engine's job, S1's, not this stub's).
// ---------------------------------------------------------------------------

export function makeTriggerRun(clock: Clock = systemClock) {
  return async function triggerRun(input: TriggerRunInput): Promise<RunRecord> {
    const now = clock.nowIso();
    const run: RunRecord = {
      runId: generateId("run"),
      workflowId: input.workflow.id,
      workflowVersion: input.workflow.version,
      status: "pending",
      approved: input.approved ?? true,
      approvalMode: input.approvalMode ?? "dev",
      trigger: input.trigger,
      inputs: input.inputs,
      params: input.environment ? { ...input.params, environment: input.environment } : input.params,
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: { workflow: input.workflow }, resolvedVersions: {}, packHashes: {}, capturedAt: now },
      startedAt: now,
      updatedAt: now,
      schemaVersion: 1,
    };
    return run;
  };
}

/** Same as `makeTriggerRun`'s returned function, but also does the store-side half of Seam 3's contract (persist + enqueue) — split out so `actions/trigger.ts` can keep calling the injected `deps.triggerRun` as a pure `(input) => Promise<RunRecord>` (matching the bound `Engine.triggerRun` shape exactly, per deps.ts) while still exercising a store in this package's own tests. */
export function makeTriggerRunAndEnqueue(store: AartStore, clock: Clock = systemClock) {
  const triggerRun = makeTriggerRun(clock);
  return async function triggerRunAndEnqueue(input: Parameters<ReturnType<typeof makeTriggerRun>>[0]): Promise<RunRecord> {
    const run = await triggerRun(input);
    await store.runs.put(run);
    await store.jobQueue.enqueue(run.runId);
    return run;
  };
}

// ---------------------------------------------------------------------------
// S1 seam — resumeApproval. Honestly scoped: this stub performs the
// documented ATOMIC CLAIM (dedupe-protected via AartStore.runs.hasDedupeKey/
// recordDedupeKey inside one transact(), matching architecture §4.4.2's
// "scope of the atomic-claim rule" extension to direct-lookup resume) and a
// minimal run-state update (status -> "running", the resolved wait removed).
// It deliberately does NOT re-derive step.if/then/else/next and run the
// step-loop forward — that "continues execution past the resumed step"
// behavior is the real `Engine.resumeApproval`'s job (S1), out of a
// dashboard stub's reach without importing the actual engine. Flagged here
// + SEAMS.md; swapped for the real bound `engine.resumeApproval` at S9
// merge with zero call-site change (same `(runId, stepId, task) =>
// Promise<ResumeOutcome>` shape).
// ---------------------------------------------------------------------------

export function makeResumeApproval(store: AartStore, clock: Clock = systemClock) {
  return async function resumeApproval(runId: string, stepId: string, task: { id: string; status: string; decision?: unknown; reviewer?: string }): Promise<ResumeOutcome> {
    const wait = await store.waits.get(runId, stepId);
    if (!wait || wait.type !== "approval") return { kind: "unmatched", mechanism: "direct_lookup" };

    const dedupeKey = `approval:${runId}:${stepId}:${task.id}`;
    const alreadyConsumed = await store.runs.hasDedupeKey(runId, dedupeKey);
    if (alreadyConsumed) return { kind: "duplicate", mechanism: "direct_lookup" };

    const run = await store.runs.get(runId);
    if (!run) return { kind: "unmatched", mechanism: "direct_lookup" };

    await store.transact(async (tx) => {
      await tx.runs.recordDedupeKey(runId, dedupeKey);
      await tx.waits.delete(runId, stepId);
      const updated: RunRecord = {
        ...run,
        status: "running",
        updatedAt: clock.nowIso(),
        waits: run.waits.filter((w) => !(w.type === "approval" && w.taskId === task.id)),
      };
      await tx.runs.put(updated);
    });

    const finalRun = await store.runs.get(runId);
    return { kind: "resumed", run: finalRun!, mechanism: "direct_lookup" };
  };
}

/** The ApprovalTask-record half of "approve human tasks" — see deps.ts's DecideApprovalTaskFn doc comment for why this is treated as a real implementation, not a swap-at-merge stub. */
export function makeDecideApprovalTask(clock: Clock = systemClock) {
  return async function decideApprovalTask(store: AartStore, taskId: string, status: "approved" | "rejected" | "needs_changes", reviewer: string, decision?: unknown): Promise<ApprovalTask> {
    const task = await store.approvals.get(taskId);
    if (!task) throw new Error(`approval task not found: ${taskId}`);
    const updated: ApprovalTask = { ...task, status, reviewer, decision, decidedAt: clock.nowIso() };
    await store.approvals.put(updated);
    return updated;
  };
}

// ---------------------------------------------------------------------------
// S8 gap-fill — approveOrDeprecateWorkflow. See deps.ts's doc comment for
// why no sibling SEAMS.md entry exists for this one (no owning function
// publishes "write Workflow.approval" — only the pure gate computation).
// The POLICY decision routes through @aart/governance's real
// computeApprovalState (imported above); this is only the "fetch + persist"
// glue around it.
// ---------------------------------------------------------------------------

export function makeApproveOrDeprecateWorkflow(clock: Clock = systemClock) {
  return async function approveOrDeprecateWorkflow(store: AartStore, workflowId: string, version: string, action: "approve" | "deprecate", requiredGatesForMode: readonly GateName[]): Promise<Workflow> {
    const workflow = await store.workflows.get(workflowId, version);
    if (!workflow) throw new Error(`workflow not found: ${workflowId}@${version}`);
    const approval = action === "deprecate" ? "deprecated" : computeApprovalState(workflow.gates, requiredGatesForMode);
    const updated: Workflow = { ...workflow, approval };
    await store.workflows.put(updated);
    void clock;
    return updated;
  };
}

// promoteWorkflowVersionToEnvironment: S9 integration (reconciliation
// ledger item 2) — this package's former local
// makePromoteWorkflowVersionToEnvironment (its own fetch/eligibility/
// Deployment-create-or-refresh reimplementation) is deleted; @aart/server's
// real promoteWorkflowVersionToEnvironment (imported above, re-exported
// from this module) does the identical job for real, including the
// Deployment persistence this package's own version used to duplicate.
// Bound directly into DashboardDeps below with zero wrapper needed - its
// real signature `(store, params, clock?)` already satisfies this
// package's `PromoteWorkflowVersionToEnvironmentFn` 2-arg type (the
// optional 3rd param defaults to systemClock server-side).

// ---------------------------------------------------------------------------
// S6 seam E4 — correction capture + 6 outcomes + 2 complements. Behavior
// mirrors each function's one-line description in S6's SEAMS.md entry.
// ---------------------------------------------------------------------------

export function makeRecordCorrection(clock: Clock = systemClock) {
  return async function recordCorrection(
    store: AartStore,
    input: { runId: string; stepId: string; fieldPath: string; observed: unknown; corrected: unknown; reason: string; reviewer: string },
  ): Promise<Correction> {
    const correction: Correction = { ...input, createdAt: clock.nowIso() };
    await store.corrections.put(correction);
    return correction;
  };
}

/** Applies `correction.corrected` to the run: a `fieldPath` of the literal form `outputs.<key>` patches `RunRecord.outputs`; anything else is treated as `<key>` inside the named step's own StepTrace.outputs (and marks that trace `postHocCorrected: true`, architecture §5.3's F5 fix / spec §23.4's "update current run output" outcome). */
export async function updateRunOutput(store: AartStore, correction: Correction): Promise<RunRecord> {
  const run = await store.runs.get(correction.runId);
  if (!run) throw new Error(`run not found: ${correction.runId}`);

  if (correction.fieldPath.startsWith("outputs.")) {
    const key = correction.fieldPath.slice("outputs.".length);
    const updated: RunRecord = { ...run, outputs: { ...run.outputs, [key]: correction.corrected } };
    await store.runs.put(updated);
    return updated;
  }

  const trace: StepTrace[] = run.trace.map((t) =>
    t.stepId === correction.stepId ? { ...t, outputs: { ...t.outputs, [correction.fieldPath]: correction.corrected }, postHocCorrected: true } : t,
  );
  const updated: RunRecord = { ...run, trace };
  await store.runs.put(updated);
  return updated;
}

export function makeCreateEvalExampleFromCorrection() {
  return async function createEvalExampleFromCorrection(store: AartStore, correction: Correction, suiteId: string, _options?: unknown): Promise<EvalExample> {
    void _options;
    const example: EvalExample = {
      id: generateId("evalex"),
      suiteId,
      sourceRunId: correction.runId,
      input: { stepId: correction.stepId, fieldPath: correction.fieldPath, observed: correction.observed },
      expected: correction.corrected,
      createdFromCorrection: `${correction.runId}:${correction.stepId}:${correction.fieldPath}:${correction.createdAt}`,
    };
    await store.evals.putExample(example);
    return example;
  };
}

export async function createIssueForAgent(store: AartStore, correction: Correction): Promise<ImprovementBrief> {
  const run = await store.runs.get(correction.runId);
  if (!run) throw new Error(`run not found: ${correction.runId}`);
  return {
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    problemSummary: `Correction on step "${correction.stepId}" field "${correction.fieldPath}": ${correction.reason}`,
    failedEvalIds: [],
    corrections: [{ summary: correction.reason, sourceRunId: correction.runId, fieldPath: correction.fieldPath }],
    constraints: [],
  };
}

export async function triggerImprovementProposal(store: AartStore, workflowId: string, workflowVersion: string, _options?: unknown): Promise<ImprovementBrief> {
  void _options;
  const runs = (await store.runs.list({ workflowId })).filter((r) => r.workflowVersion === workflowVersion);
  const corrections: Correction[] = [];
  for (const run of runs) {
    corrections.push(...(await store.corrections.list({ runId: run.runId })));
  }
  return {
    workflowId,
    workflowVersion,
    problemSummary: corrections.length > 0 ? `${corrections.length} correction(s) recorded against ${workflowId}@${workflowVersion}` : `Improvement proposal requested for ${workflowId}@${workflowVersion}`,
    failedEvalIds: [],
    corrections: corrections.map((c) => ({ summary: c.reason, sourceRunId: c.runId, fieldPath: c.fieldPath })),
    constraints: [],
  };
}

function makeWorkflowFlagSetter(field: "promotionBlocked" | "needsReview", value: boolean) {
  return async function setFlag(store: AartStore, workflowId: string, workflowVersion: string): Promise<Workflow> {
    const workflow = await store.workflows.get(workflowId, workflowVersion);
    if (!workflow) throw new Error(`workflow not found: ${workflowId}@${workflowVersion}`);
    const updated: Workflow = { ...workflow, [field]: value };
    await store.workflows.put(updated);
    return updated;
  };
}

export const blockPromotion = makeWorkflowFlagSetter("promotionBlocked", true);
export const unblockPromotion = makeWorkflowFlagSetter("promotionBlocked", false);
export const markNeedsReview = makeWorkflowFlagSetter("needsReview", true);
export const clearNeedsReview = makeWorkflowFlagSetter("needsReview", false);

// ---------------------------------------------------------------------------
// S6 seam E3 — report renderers. A genuinely-functional (not placeholder)
// minimal implementation: real redaction pass, real HTML/Markdown/JSON
// output shaped like spec §19.3/§32.7 describe. Swapped for @aart/evidence's
// real createReportRenderers at S9 merge with zero call-site change.
// ---------------------------------------------------------------------------

export function createReportRenderers(redact: DashboardDeps["redact"]): ReportRenderers {
  function redacted(run: RunRecord, resolvedSecretRefs?: ReadonlySet<string>): RunRecord {
    return redact(run, resolvedSecretRefs ?? new Set()) as RunRecord;
  }
  return {
    modelFacing(run, resolvedSecretRefs) {
      const r = redacted(run, resolvedSecretRefs);
      const headline = r.status === "completed" ? "passed" : r.status === "waiting" ? "waiting" : "failed";
      return {
        headline,
        workflowId: r.workflowId,
        workflowVersion: r.workflowVersion,
        failures: r.trace.filter((t) => t.status === "failed").map((t) => ({ stepId: t.stepId, block: t.block, error: t.error ?? "unknown error" })),
        outputs: r.outputs ?? {},
        artifactRefs: r.artifacts.map((a) => ({ id: a.id, kind: a.kind, uri: a.path })),
        next: headline === "waiting" ? "wait for resume" : headline === "passed" ? "done" : "inspect failures",
      };
    },
    markdown(run, resolvedSecretRefs) {
      const r = redacted(run, resolvedSecretRefs);
      const lines = [
        `# Run ${r.runId}`,
        ``,
        `- Workflow: ${r.workflowId}@${r.workflowVersion}`,
        `- Status: ${r.status}`,
        `- Started: ${r.startedAt}`,
        ``,
        `## Outputs`,
        "```json",
        JSON.stringify(r.outputs ?? {}, null, 2),
        "```",
        ``,
        `## Steps`,
      ];
      for (const t of r.trace) lines.push(`- \`${t.stepId}\` (${t.block}): ${t.status}${t.error ? ` — ${t.error}` : ""}`);
      return lines.join("\n");
    },
    html(run, resolvedSecretRefs) {
      const r = redacted(run, resolvedSecretRefs);
      const rows = r.trace
        .map((t) => `<tr><td>${escapeHtml(t.stepId)}</td><td>${escapeHtml(t.block)}</td><td>${escapeHtml(t.status)}</td><td>${escapeHtml(t.error ?? "")}</td></tr>`)
        .join("\n");
      return `<section class="run-report" data-run-id="${escapeHtml(r.runId)}">
<h2>Run ${escapeHtml(r.runId)}</h2>
<p>Workflow: ${escapeHtml(r.workflowId)}@${escapeHtml(r.workflowVersion)} — Status: ${escapeHtml(r.status)}</p>
<table><thead><tr><th>Step</th><th>Block</th><th>Status</th><th>Error</th></tr></thead><tbody>
${rows}
</tbody></table>
</section>`;
    },
    prComment(run, resolvedSecretRefs, options) {
      void options;
      const r = redacted(run, resolvedSecretRefs);
      return `**AART run ${r.runId}** — ${r.status} (${r.workflowId}@${r.workflowVersion})`;
    },
    json(run, resolvedSecretRefs) {
      return JSON.stringify(redacted(run, resolvedSecretRefs));
    },
    cliText(run, resolvedSecretRefs) {
      const r = redacted(run, resolvedSecretRefs);
      return `Run ${r.runId} [${r.status}] ${r.workflowId}@${r.workflowVersion}`;
    },
  };
}

// ---------------------------------------------------------------------------
// S6 seam E2/run-suite.ts — a minimal scorer registry (exact_match + a
// permissive fallback) and runEvalSuite mirroring the real algorithm read
// from S6's sibling worktree source: per-example execute+score, average
// score, `improvements` always [] (documented there as "out of scope,
// needs prior-run history"), synthetic `reportArtifact` when the caller
// doesn't supply a real one.
// ---------------------------------------------------------------------------

export function createScorerRegistry(_options?: { llmJudge?: unknown }): ScorerRegistry {
  void _options;
  const kinds = ["exact_match"] as const;
  async function score(kind: string, actual: unknown, expected: unknown, _config?: unknown): Promise<ScorerResult> {
    void _config;
    if (kind === "exact_match") {
      const passed = JSON.stringify(actual) === JSON.stringify(expected);
      return { passed, score: passed ? 1 : 0 };
    }
    // Unknown/unregistered kind (matches S6's own documented behavior for
    // an unwired llm_judge: "throws a clear, descriptive error" — this
    // stub scorer instead scores 0/fail rather than throwing, since most
    // dashboard-triggered eval runs shouldn't hard-crash on an unfamiliar
    // pack-provided scorer kind; flagged here as a deliberate divergence).
    return { passed: false, score: 0, detail: `no scorer registered for kind "${kind}"` };
  }
  return {
    kinds,
    get: (kind) => (kinds.includes(kind as (typeof kinds)[number]) ? { kind } : undefined),
    score,
  };
}

export async function runEvalSuite(
  suite: EvalSuite,
  options: {
    dryRun?: boolean;
    execute: (input: unknown, ctx: { dryRun: boolean }) => unknown | Promise<unknown>;
    scorers: ScorerRegistry;
    workflowId: string;
    workflowVersion: string;
    reportArtifact: string;
  },
): Promise<{ evalRun: EvalRun; results: Array<{ exampleId: string; actual: unknown; result: ScorerResult }> }> {
  const dryRun = options.dryRun ?? false;
  const results: Array<{ exampleId: string; actual: unknown; result: ScorerResult }> = [];
  for (const example of suite.examples) {
    const actual = await options.execute(example.input, { dryRun });
    const result = await options.scorers.score(suite.scorer.kind, actual, example.expected, example.scorerConfig ?? suite.scorer.config);
    results.push({ exampleId: example.id, actual, result });
  }
  const total = results.length;
  const passed = results.filter((r) => r.result.passed).length;
  const failed = total - passed;
  const score = total === 0 ? 1 : results.reduce((sum, r) => sum + r.result.score, 0) / total;
  const regressions = results.filter((r) => !r.result.passed).map((r) => r.exampleId);
  const evalRun: EvalRun = {
    id: generateId("evalrun"),
    suiteId: suite.id,
    workflowId: options.workflowId,
    workflowVersion: options.workflowVersion,
    status: "completed",
    total,
    passed,
    failed,
    score,
    regressions,
    improvements: [],
    reportArtifact: options.reportArtifact,
  };
  return { evalRun, results };
}

/** Default `execute` for local/test use — echoes `input` back untouched (no engine dependency, matching run-suite.ts's own documented decoupling from real execution). A caller wiring a real engine at S9 merge supplies a real `execute` instead. */
export function echoExecute(input: unknown): unknown {
  return input;
}

// ---------------------------------------------------------------------------
// S8 gap-fill — createEvalSuite. Trivial store glue (no policy decision),
// so treated as this package's own real implementation rather than a
// swap-at-merge stub.
// ---------------------------------------------------------------------------

export async function createEvalSuite(
  store: AartStore,
  input: { name: string; description?: string; scorer: Scorer; examples?: EvalExample[]; tags?: string[] },
): Promise<EvalSuite> {
  const suite: EvalSuite = {
    id: generateId("evalsuite"),
    name: input.name,
    description: input.description,
    examples: input.examples ?? [],
    scorer: input.scorer,
    tags: input.tags ?? [],
  };
  await store.evals.putSuite(suite);
  for (const example of suite.examples) {
    await store.evals.putExample(example);
  }
  return suite;
}

// ---------------------------------------------------------------------------
// identityRedact — a never-invoked-in-production stand-in for S4's real
// redactRecord (architecture §7.9). Mirrors @aart/engine's own documented
// default-stub convention ("identityRedactFn ... in tests").
// ---------------------------------------------------------------------------

export function identityRedact(record: unknown, _resolvedSecretRefs: ReadonlySet<string>): unknown {
  void _resolvedSecretRefs;
  return record;
}

export function createStubDeps(store: AartStore, clock: Clock = systemClock): DashboardDeps {
  return {
    redact: identityRedact,
    clearRunFlag: makeClearRunFlag(clock),
    listFlaggedRuns,
    triggerRun: makeTriggerRunAndEnqueue(store, clock),
    resumeApproval: makeResumeApproval(store, clock),
    decideApprovalTask: makeDecideApprovalTask(clock),
    computeApprovalState,
    evaluatePromotionForEnvironment,
    semanticRiskDiff: makeSemanticRiskDiff(store),
    requiredGatesByTrustMode: REQUIRED_GATES_BY_TRUST_MODE,
    recordCorrection: makeRecordCorrection(clock),
    updateRunOutput,
    createEvalExampleFromCorrection: makeCreateEvalExampleFromCorrection(),
    createIssueForAgent,
    triggerImprovementProposal,
    blockPromotion,
    unblockPromotion,
    markNeedsReview,
    clearNeedsReview,
    createReportRenderers,
    createScorerRegistry,
    runEvalSuite,
    approveOrDeprecateWorkflow: makeApproveOrDeprecateWorkflow(clock),
    // Explicit wrapper (not a bare reference) so this DashboardDeps
    // instance's own injected `clock` threads through to the Deployment
    // record's `createdAt` - matching every other clock-sensitive field in
    // this container (e.g. clearRunFlag/resumeApproval above). Adapts this
    // package's own (narrower) Clock into @aart/server's Clock shape -
    // server's Clock additionally requires `setTimeout` (its own
    // ticker/lease/reclaim timer-driven logic needs it) which
    // promoteWorkflowVersionToEnvironment itself never calls (verified: it
    // only ever calls `.nowIso()`), so the adapter's setTimeout is
    // deliberately a structural-typing satisfier only, never invoked.
    promoteWorkflowVersionToEnvironment: (store, params) =>
      promoteWorkflowVersionToEnvironment(store, params, { ...clock, setTimeout: () => ({ cancel() {} }) }),
    createEvalSuite,
  };
}
