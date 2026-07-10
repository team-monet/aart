import { describe, expect, it } from "vitest";
import { WaitConditionApprovalSchema } from "@aart/types";
import { humanApprovalBlock } from "./approval.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("human.approval", () => {
  it("has complete, correctly-declared metadata (capability-free, wait-shaped)", () => {
    expect(humanApprovalBlock.manifest.id).toBe("human.approval");
    expect(humanApprovalBlock.manifest.capabilities).toEqual([]);
    expect(humanApprovalBlock.manifest.category).toBe("human");
  });

  it("constructs a WaitCondition{type: 'approval'} shape carrying title/description through", async () => {
    const result = await humanApprovalBlock.execute(
      { title: "Approve refund", description: "Refund outside policy", taskId: "task-1", timeout: "P1D" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({
      type: "approval",
      taskId: "task-1",
      timeout: "P1D",
      title: "Approve refund",
      description: "Refund outside policy",
    });
  });

  it("defaults taskId to `<runId>:<stepId>` when not provided", async () => {
    const result = await humanApprovalBlock.execute(
      { title: "x", description: "y" },
      fakeExecutionContext({ runId: "run-abc", stepId: "step-xyz" }),
    );
    expect(result).toMatchObject({ taskId: "run-abc:step-xyz" });
  });

  it("produces output whose WaitCondition-shaped fields validate against the frozen WaitConditionApprovalSchema once a schemaVersion is stamped on (title/description are this block's own documented extension beyond the frozen shape, and are permissively ignored by .parse on a non-strict zod object)", async () => {
    const result = await humanApprovalBlock.execute({ title: "x", description: "y" }, fakeExecutionContext());
    expect(() => WaitConditionApprovalSchema.parse({ ...(result as Record<string, unknown>), schemaVersion: 1 })).not.toThrow();
  });
});
