// @aart/familiarity-evals — a CI-gate suite that evaluates AART's OWN tool
// surface for model-nativeness (ADR-15; spec §32.4). A genuinely separate
// package from @aart/evidence's per-workflow eval system (spec §24): the
// SUBJECT under test here is AART's own API surface (tool descriptions,
// schemas, block names), not a user workflow.
//
// Owned by S6 (implementation plan §3). This session builds authoring-task
// suite definitions, deterministic scoring (aart_validate + run-success —
// NOT an LLM judge, per ADR-15), and a model-runner interface with a
// fake-model adapter so this package is fully offline-testable. This
// session does NOT wire CI or run a real-model baseline — that's S9's job
// (see SEAMS.md for the ValidateFn/RunSuccessFn seams S9/S4/S1 fill in
// later).
export * from "./adoption.js";
export * from "./local-tool-adoption.js";
export * from "./model-runner.js";
export * from "./run-success.js";
export * from "./scoring.js";
export * from "./suite.js";
export * from "./tasks/index.js";
export * from "./types.js";
export * from "./validate.js";
