import { describe, expect, it } from "vitest";
import { createReportJsonBlock, reportJsonBlock } from "./report-json.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";
import { fakeRunRecord } from "../test-support/fixtures.js";
import type { ReportRenderersPort } from "./report-renderers-port.js";

describe("report.json", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(reportJsonBlock.manifest.id).toBe("report.json");
    expect(reportJsonBlock.manifest.capabilities).toEqual([]);
    expect(reportJsonBlock.manifest.category).toBe("report");
  });

  it("uses the injected ReportRenderersPort when one is provided", async () => {
    const fakeRenderers: ReportRenderersPort = {
      modelFacing: () => ({ headline: "passed", workflowId: "w", workflowVersion: "1", failures: [], artifactRefs: [], next: "" }),
      markdown: () => "",
      html: () => "",
      prComment: () => "",
      json: () => "INJECTED-JSON",
      cliText: () => "",
    };
    const block = createReportJsonBlock(fakeRenderers);
    const result = await block.execute({ run: fakeRunRecord() }, fakeExecutionContext());
    expect(result).toEqual({ json: "INJECTED-JSON" });
  });

  it("falls back to the local renderer (does not throw) when nothing is injected and @aart/evidence is still a stub", async () => {
    const run = fakeRunRecord({ runId: "run-fallback-test" });
    const result = await reportJsonBlock.execute({ run }, fakeExecutionContext());
    expect(JSON.parse((result as { json: string }).json).runId).toBe("run-fallback-test");
  });

  it("rejects a run input that doesn't match the frozen RunRecord shape", async () => {
    await expect(reportJsonBlock.execute({ run: { not: "a run record" } }, fakeExecutionContext())).rejects.toThrow();
  });
});
