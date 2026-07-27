// StubEvidence — mirrors @aart/evidence's real, documented exports (S6
// SEAMS.md E3 `createReportRenderers(redact).modelFacing/markdown`, E4's
// correction-outcome function set). Real @aart/evidence is still an S0
// `export {}` stub in THIS worktree (S6 builds it in the concurrent,
// unmerged /Users/johnlee/code/aart-s6).
//
// What IS real: recordCorrection / createEvalExampleFromCorrection write
// real, schema-valid records through the real (frozen) @aart/store — spec
// §23.3's Correction and §24.1's EvalExample shapes need no rendering logic,
// just correct field mapping, so this worktree can do that part for real.
//
// What's SIMPLIFIED (flagged): modelFacingReport/markdownReport render
// directly from a RunRecord's own fields (no redaction chokepoint applied —
// see stubs/governance.ts's `redact` for why that's a separate, also-
// simplified concern); runEval scores only `exact_match`/`jsonpath_contains`
// against the stub engine's (necessarily fake) run outputs, a small fraction
// of S6's real 12-kind scorer registry (architecture §9.5).
import type { AartStore } from "@aart/store";
import type { Correction, EvalExample, EvalRun, EvalSuite, GateStatus, ModelFacingReport, RunRecord, Trigger, Workflow } from "@aart/types";
import type { EnginePort, EvidencePort } from "../types.js";
import { newId } from "./engine.js";

/**
 * Mirrors @aart/evidence/src/evals/promotion-gate.ts's computeEvalsGateStatus
 * EXACTLY (S14 "gate write paths") — a trivial, fully-specified threshold
 * comparison (architecture §9.6), not a faked/simplified simulation like
 * this module's runEval above, so there is nothing to diverge from the real
 * implementation: both sides are the same one-line algorithm.
 */
export function computeEvalsGateStatus(evalRun: EvalRun, minScore: number): GateStatus {
  return evalRun.score >= minScore ? "passed" : "failed";
}

const HEADLINE_BY_STATUS: Record<RunRecord["status"], ModelFacingReport["headline"]> = {
  completed: "passed",
  failed: "failed",
  cancelled: "failed",
  waiting: "waiting",
  pending: "waiting",
  running: "waiting",
};

function nextForHeadline(headline: ModelFacingReport["headline"]): string {
  switch (headline) {
    case "passed":
      return "Run completed successfully. Call aart_promote_workflow if this version is ready to promote, or aart_deploy_workflow if it's already approved.";
    case "failed":
      return "Run failed — inspect failures[] for the failing step/block/error. Call aart_record_correction if the fix is a data/output correction, otherwise revise the workflow draft and call aart_validate again.";
    case "waiting":
      return "Run is waiting. Call aart_list_waiting_runs for details, then aart_resume_run (or aart_approve for a human.approval wait) to continue.";
  }
}

export function buildModelFacingReport(run: RunRecord): ModelFacingReport {
  const headline = HEADLINE_BY_STATUS[run.status];
  const failures = run.trace
    .filter((t) => t.status === "failed")
    .map((t) => ({ stepId: t.stepId, block: t.block, error: t.error ?? "step failed" }));
  const artifactRefs = run.artifacts.map((a) => ({ id: a.id, kind: a.kind, uri: a.path }));
  return {
    headline,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    failures,
    outputs: run.outputs ?? {},
    artifactRefs,
    next: nextForHeadline(headline),
  };
}

export function buildMarkdownReport(run: RunRecord): string {
  const lines: string[] = [];
  lines.push(`# Run ${run.runId}`, "", `Workflow: ${run.workflowId}@${run.workflowVersion}`, `Status: ${run.status}`, "");
  lines.push("## Steps", "");
  for (const t of run.trace) {
    lines.push(`- [${t.status}] ${t.stepId} (\`${t.block}\`)${t.error ? ` — ${t.error}` : ""}`);
  }
  if (run.artifacts.length > 0) {
    lines.push("", "## Artifacts", "");
    for (const a of run.artifacts) lines.push(`- ${a.name} (${a.kind}): ${a.path}`);
  }
  return lines.join("\n");
}

async function runOneExample(
  engine: EnginePort,
  workflow: Workflow,
  example: EvalExample,
  scorerKind: string,
): Promise<{ passed: boolean }> {
  const inputs =
    example.input && typeof example.input === "object" && !Array.isArray(example.input)
      ? (example.input as Record<string, unknown>)
      : {};
  const trigger: Trigger = {
    id: newId("trig"),
    type: "mcp",
    source: "aart_run_eval",
    payload: inputs,
    receivedAt: new Date().toISOString(),
  };
  const created = await engine.triggerRun({ workflow, trigger, inputs });
  const finished = await engine.executeRun(created.runId);
  if (scorerKind === "exact_match") {
    return { passed: JSON.stringify(finished.outputs ?? {}) === JSON.stringify(example.expected) };
  }
  if (scorerKind === "jsonpath_contains" && typeof example.expected === "string") {
    return { passed: JSON.stringify(finished.outputs ?? {}).includes(example.expected) };
  }
  // Fallback per spec §32.4: "aart_validate result plus run success are
  // enough to score every example" — a deterministic did-it-run-and-succeed
  // check when the scorer kind isn't one of the two implemented here.
  return { passed: finished.status === "completed" };
}

export function createStubEvidence(store: AartStore, engine: EnginePort): EvidencePort {
  return {
    modelFacingReport: buildModelFacingReport,
    markdownReport: buildMarkdownReport,

    async recordCorrection(input): Promise<Correction> {
      const correction: Correction = {
        runId: input.runId,
        stepId: input.stepId,
        fieldPath: input.fieldPath,
        observed: input.observed,
        corrected: input.corrected,
        reason: input.reason,
        reviewer: input.reviewer,
        createdAt: new Date().toISOString(),
      };
      await store.corrections.put(correction);
      return correction;
    },

    async createEvalExampleFromCorrection(correction: Correction, suiteId: string): Promise<EvalExample> {
      const example: EvalExample = {
        id: newId("example"),
        suiteId,
        sourceRunId: correction.runId,
        input: { stepId: correction.stepId, fieldPath: correction.fieldPath, observed: correction.observed },
        expected: correction.corrected,
        tags: ["from-correction"],
        createdFromCorrection: `${correction.runId}:${correction.stepId}:${correction.fieldPath}`,
      };
      await store.evals.putExample(example);
      return example;
    },

    async runEval(suite: EvalSuite, workflowId: string, workflowVersion: string): Promise<EvalRun> {
      const workflow = await store.workflows.get(workflowId, workflowVersion);
      if (!workflow) throw new Error(`runEval: workflow ${workflowId}@${workflowVersion} not found`);
      let passed = 0;
      let failed = 0;
      const regressions: string[] = [];
      for (const example of suite.examples) {
        const result = await runOneExample(engine, workflow, example, suite.scorer.kind);
        if (result.passed) passed += 1;
        else {
          failed += 1;
          regressions.push(example.id);
        }
      }
      const total = suite.examples.length;
      const evalRun: EvalRun = {
        id: newId("evalrun"),
        suiteId: suite.id,
        workflowId,
        workflowVersion,
        status: "completed",
        total,
        passed,
        failed,
        score: total > 0 ? passed / total : 1,
        regressions,
        improvements: [],
        reportArtifact: "",
      };
      await store.evals.putRun(evalRun);
      return evalRun;
    },

    computeEvalsGateStatus,
  };
}
