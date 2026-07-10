import { createFsStore, type AartStore } from "@aart/store";
import type { EvalExample, EvalRun, ImprovementBrief } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateImprovementBrief, renderImprovementBrief } from "./improvement-brief.js";
import { fixtureRunRecord } from "./test-support/fixtures.js";

describe("renderImprovementBrief — tested against spec §25.2's literal rendered example as a fixture (this session's DoD)", () => {
  it("reproduces the exact spec §25.2 text for the exact spec §25.2 ImprovementBrief object", () => {
    const brief: ImprovementBrief = {
      workflowId: "energy.extract-bill",
      workflowVersion: "0.1.0",
      problemSummary: "failed 3 eval examples",
      failedEvalIds: ["ex1", "ex2", "ex3"],
      corrections: [
        { summary: "NMI extracted incorrectly on Origin bill layout" },
        { summary: "demand charge omitted on AGL bill" },
        { summary: "GST total confused with ex-GST subtotal" },
      ],
      constraints: ["preserve existing passing evals", "do not add new external dependencies unless necessary", "pricing calculations must remain deterministic"],
    };

    const expected = [
      "Workflow: energy.extract-bill@0.1.0",
      "Problem: failed 3 eval examples",
      "Corrections:",
      "- NMI extracted incorrectly on Origin bill layout",
      "- demand charge omitted on AGL bill",
      "- GST total confused with ex-GST subtotal",
      "",
      "Please propose a new workflow/block version.",
      "Constraints:",
      "- preserve existing passing evals",
      "- do not add new external dependencies unless necessary",
      "- pricing calculations must remain deterministic",
    ].join("\n");

    expect(renderImprovementBrief(brief)).toBe(expected);
  });
});

let root: string;
let store: AartStore;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-evidence-improvement-brief-"));
  store = createFsStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("generateImprovementBrief — store aggregation logic", () => {
  it("collects failedEvalIds from EvalRun.regressions for the exact (workflowId, workflowVersion)", async () => {
    const run: EvalRun = {
      id: "er1",
      suiteId: "s1",
      workflowId: "wf_x",
      workflowVersion: "0.1.0",
      status: "completed",
      total: 2,
      passed: 1,
      failed: 1,
      score: 0.5,
      regressions: ["ex_bad"],
      improvements: [],
      reportArtifact: "art1",
    };
    // A run for a DIFFERENT version must not contribute.
    const otherVersionRun: EvalRun = { ...run, id: "er2", workflowVersion: "0.2.0", regressions: ["ex_should_not_appear"] };
    await store.evals.putRun(run);
    await store.evals.putRun(otherVersionRun);

    const brief = await generateImprovementBrief(store, "wf_x", "0.1.0");
    expect(brief.failedEvalIds).toEqual(["ex_bad"]);
    expect(brief.problemSummary).toBe("failed 1 eval example");
  });

  it("includes a Correction attached to a run of this workflow version when it is NOT YET referenced by any EvalExample", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_a", workflowId: "wf_y", workflowVersion: "0.1.0" }));
    await store.corrections.put({
      runId: "run_a",
      stepId: "extract",
      fieldPath: "outputs.nmi",
      observed: "1",
      corrected: "2",
      reason: "unreferenced correction",
      reviewer: "jane",
      createdAt: new Date().toISOString(),
    });

    const brief = await generateImprovementBrief(store, "wf_y", "0.1.0");
    expect(brief.corrections).toEqual([{ summary: "unreferenced correction", sourceRunId: "run_a", fieldPath: "outputs.nmi" }]);
  });

  it("EXCLUDES a Correction once an EvalExample references it — the predicate direction matters (architecture §9.7: 'does any EvalExample reference this correction,' not 'is this correction's own field unset')", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_b", workflowId: "wf_z", workflowVersion: "0.1.0" }));
    const correction = {
      runId: "run_b",
      stepId: "extract",
      fieldPath: "outputs.nmi",
      observed: "1",
      corrected: "2",
      reason: "now-referenced correction",
      reviewer: "jane",
      createdAt: new Date().toISOString(),
    };
    await store.corrections.put(correction);

    await store.evals.putSuite({ id: "suite_ref", name: "n", examples: [], scorer: { id: "sc1", kind: "exact_match" }, tags: [] });
    const example: EvalExample = {
      id: "ex_ref",
      suiteId: "suite_ref",
      input: {},
      expected: {},
      createdFromCorrection: "run_b:extract:outputs.nmi",
    };
    await store.evals.putExample(example);

    const brief = await generateImprovementBrief(store, "wf_z", "0.1.0");
    expect(brief.corrections).toEqual([]);
  });

  it("does not include corrections from a DIFFERENT workflow version's runs", async () => {
    await store.runs.put(fixtureRunRecord({ runId: "run_v1", workflowId: "wf_multi", workflowVersion: "0.1.0" }));
    await store.runs.put(fixtureRunRecord({ runId: "run_v2", workflowId: "wf_multi", workflowVersion: "0.2.0" }));
    await store.corrections.put({
      runId: "run_v2",
      stepId: "s",
      fieldPath: "outputs.x",
      observed: 1,
      corrected: 2,
      reason: "belongs to v0.2.0 only",
      reviewer: "jane",
      createdAt: new Date().toISOString(),
    });

    const brief = await generateImprovementBrief(store, "wf_multi", "0.1.0");
    expect(brief.corrections).toEqual([]);
  });

  it("passes options.constraints through verbatim, defaulting to an empty array", async () => {
    await expect(generateImprovementBrief(store, "wf_empty", "0.1.0")).resolves.toMatchObject({ constraints: [] });
    await expect(generateImprovementBrief(store, "wf_empty", "0.1.0", { constraints: ["c1"] })).resolves.toMatchObject({ constraints: ["c1"] });
  });
});
