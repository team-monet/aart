import { describe, expect, it } from "vitest";
import type { ModelFacingReport } from "@aart/types";
import { createReportSummarizeBlock, reportSummarizeBlock } from "./report-summarize.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { fakeRunRecord } from "../test-support/fixtures.js";
import type { ReportRenderersPort } from "./report-renderers-port.js";

describe("report.summarize", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(reportSummarizeBlock.manifest.id).toBe("report.summarize");
    expect(reportSummarizeBlock.manifest.capabilities).toEqual([]);
    expect(reportSummarizeBlock.manifest.category).toBe("report");
  });

  it("uses the injected ReportRenderersPort when one is provided", async () => {
    const fakeReport: ModelFacingReport = { headline: "passed", workflowId: "w", workflowVersion: "1", failures: [], outputs: { result: "ok" }, artifactRefs: [], next: "" };
    const fakeRenderers: ReportRenderersPort = {
      modelFacing: () => fakeReport,
      markdown: () => "",
      html: () => "",
      prComment: () => "",
      json: () => "{}",
      cliText: () => "",
    };
    const block = createReportSummarizeBlock(fakeRenderers);
    const result = await block.execute({ run: fakeRunRecord() }, fakeExecutionContext());
    expect(result).toEqual({ report: fakeReport });
  });

  it("falls back to the local renderer (does not throw) when nothing is injected and @aart/evidence is still a stub", async () => {
    const run = fakeRunRecord({ runId: "run-fallback-test", workflowId: "wf-x", workflowVersion: "2.0.0" });
    const result = await reportSummarizeBlock.execute({ run }, fakeExecutionContext());
    expect((result as { report: ModelFacingReport }).report).toMatchObject({
      workflowId: "wf-x",
      workflowVersion: "2.0.0",
      headline: "passed",
    });
  });

  it("rejects a run input that doesn't match the frozen RunRecord shape", async () => {
    await expect(reportSummarizeBlock.execute({ run: { not: "a run record" } }, fakeExecutionContext())).rejects.toThrow();
  });
});
