import { describe, expect, it } from "vitest";
import { WaitConditionExternalJobSchema } from "@aart/types";
import { waitForExternalJobBlock } from "./for-external-job.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("wait.for_external_job", () => {
  it("has complete, correctly-declared metadata (capability-free, per the Wait group's engine-handoff design)", () => {
    expect(waitForExternalJobBlock.manifest.id).toBe("wait.for_external_job");
    expect(waitForExternalJobBlock.manifest.capabilities).toEqual([]);
    expect(waitForExternalJobBlock.manifest.category).toBe("wait");
  });

  it("constructs a WaitCondition{type: 'external_job'} shape from its with: parameters", async () => {
    const result = await waitForExternalJobBlock.execute(
      { provider: "databricks", jobId: "job-456", timeout: "PT6H" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ type: "external_job", provider: "databricks", jobId: "job-456", timeout: "PT6H" });
  });

  it("omits timeout when not provided", async () => {
    const result = await waitForExternalJobBlock.execute({ provider: "x", jobId: "y" }, fakeExecutionContext());
    expect(result).toMatchObject({ type: "external_job", provider: "x", jobId: "y" });
  });

  it("produces output that validates against the frozen WaitConditionExternalJobSchema once a schemaVersion is stamped on (the engine's job, not this block's)", async () => {
    const result = await waitForExternalJobBlock.execute({ provider: "x", jobId: "y" }, fakeExecutionContext());
    expect(() => WaitConditionExternalJobSchema.parse({ ...(result as Record<string, unknown>), schemaVersion: 1 })).not.toThrow();
  });
});
