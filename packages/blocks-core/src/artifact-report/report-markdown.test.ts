import { describe, expect, it } from "vitest";
import { createReportMarkdownBlock, reportMarkdownBlock } from "./report-markdown.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { fakeRunRecord } from "../test-support/fixtures.js";
import type { ReportRenderersPort } from "./report-renderers-port.js";

describe("report.markdown", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(reportMarkdownBlock.manifest.id).toBe("report.markdown");
    expect(reportMarkdownBlock.manifest.capabilities).toEqual([]);
    expect(reportMarkdownBlock.manifest.category).toBe("report");
  });

  it("uses the injected ReportRenderersPort when one is provided", async () => {
    const fakeRenderers: ReportRenderersPort = {
      modelFacing: () => ({ headline: "passed", workflowId: "w", workflowVersion: "1", failures: [], artifactRefs: [], next: "" }),
      markdown: () => "INJECTED-MARKDOWN",
      html: () => "",
      prComment: () => "",
      json: () => "{}",
      cliText: () => "",
    };
    const block = createReportMarkdownBlock(fakeRenderers);
    const result = await block.execute({ run: fakeRunRecord() }, fakeExecutionContext());
    expect(result).toEqual({ markdown: "INJECTED-MARKDOWN" });
  });

  it("falls back to the local renderer (does not throw) when nothing is injected and @aart/evidence is still a stub", async () => {
    const run = fakeRunRecord({ runId: "run-fallback-test" });
    const result = await reportMarkdownBlock.execute({ run }, fakeExecutionContext());
    expect((result as { markdown: string }).markdown).toContain("run-fallback-test");
  });

  it("rejects a run input that doesn't match the frozen RunRecord shape", async () => {
    await expect(reportMarkdownBlock.execute({ run: { not: "a run record" } }, fakeExecutionContext())).rejects.toThrow();
  });
});
