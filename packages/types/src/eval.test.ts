import { describe, expect, it } from "vitest";
import { EvalExampleSchema, EvalRunSchema, EvalSuiteSchema, ImprovementBriefSchema, ScorerSchema } from "./eval.js";

describe("ScorerSchema", () => {
  it("round-trips a Scorer", () => {
    const input = { id: "scorer_1", kind: "field_level_accuracy" };
    expect(ScorerSchema.parse(input)).toEqual(input);
  });

  it("accepts an optional config payload", () => {
    const parsed = ScorerSchema.parse({ id: "scorer_2", kind: "numeric_tolerance", config: { tolerance: 0.01 } });
    expect(parsed.config).toEqual({ tolerance: 0.01 });
  });
});

describe("EvalExampleSchema", () => {
  it("round-trips an EvalExample created from a correction", () => {
    const input = {
      id: "ex_1",
      suiteId: "suite_1",
      sourceRunId: "run_1",
      input: { text: "..." },
      expected: { nmi: "6401234568" },
      createdFromCorrection: "run_1__extract_bill__outputs.nmi",
    };
    expect(EvalExampleSchema.parse(input)).toEqual(input);
  });
});

describe("EvalSuiteSchema", () => {
  it("round-trips an EvalSuite", () => {
    const input = {
      id: "suite_1",
      name: "bill-extraction",
      examples: [{ id: "ex_1", suiteId: "suite_1", input: {}, expected: {} }],
      scorer: { id: "scorer_1", kind: "field_level_accuracy" },
      tags: ["energy"],
    };
    expect(EvalSuiteSchema.parse(input)).toEqual(input);
  });
});

describe("EvalRunSchema", () => {
  it("round-trips an EvalRun", () => {
    const input = {
      id: "evalrun_1",
      suiteId: "suite_1",
      workflowId: "energy.extract-bill",
      workflowVersion: "0.1.0",
      status: "completed" as const,
      total: 10,
      passed: 7,
      failed: 3,
      score: 0.7,
      regressions: ["ex_4"],
      improvements: [],
      reportArtifact: "artifacts/evalrun_1/report.json",
    };
    expect(EvalRunSchema.parse(input)).toEqual(input);
  });
});

describe("ImprovementBriefSchema", () => {
  it("round-trips the spec §25.2 improvement-brief example", () => {
    const input = {
      workflowId: "energy.extract-bill",
      workflowVersion: "0.1.0",
      problemSummary: "failed 3 eval examples",
      failedEvalIds: ["ex_1", "ex_2", "ex_3"],
      corrections: [
        { summary: "NMI extracted incorrectly on Origin bill layout", sourceRunId: "run_1", fieldPath: "outputs.nmi" },
      ],
      constraints: ["preserve existing passing evals", "pricing calculations must remain deterministic"],
    };
    expect(ImprovementBriefSchema.parse(input)).toEqual(input);
  });
});
