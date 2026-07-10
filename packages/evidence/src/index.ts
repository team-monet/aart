// @aart/evidence — RunRecord report renderers, correction capture +
// outcomes, eval suites/scorers/runs with dry-run + connector-fake
// side-effect-safe execution, and improvement brief generation. Architecture
// §9 (full section); spec §19.3-19.4, §23-25, §32.7.
//
// Owned by S6 (implementation plan §3). Consumed frozen interfaces:
// @aart/types (RunRecord, EvalSuite/EvalExample/EvalRun, Correction,
// ImprovementBrief), @aart/store. Consumes S4's redactRecord (via the
// RedactFn type — see redact.ts) and S7's @aart/llm llm.judge (via the
// LlmJudgeFn seam — see evals/scorers/llm-judge.ts and SEAMS.md).
export * from "./corrections/index.js";
export * from "./evals/index.js";
export * from "./improvement-brief.js";
export * from "./redact.js";
export * from "./report-model.js";
export * from "./renderers/index.js";
