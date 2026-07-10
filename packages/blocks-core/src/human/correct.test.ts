import { describe, expect, it } from "vitest";
import { WaitConditionApprovalSchema } from "@aart/types";
import { humanCorrectBlock } from "./correct.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("human.correct", () => {
  it("has complete, correctly-declared metadata (capability-free, wait-shaped)", () => {
    expect(humanCorrectBlock.manifest.id).toBe("human.correct");
    expect(humanCorrectBlock.manifest.capabilities).toEqual([]);
    expect(humanCorrectBlock.manifest.category).toBe("human");
  });

  it("constructs a WaitCondition{type: 'approval'} shape carrying title/description/currentValue through", async () => {
    const result = await humanCorrectBlock.execute(
      { title: "Confirm total", description: "Please confirm", currentValue: 104.5, taskId: "task-2", timeout: "P2D" },
      fakeExecutionContext(),
    );
    expect(result).toEqual({
      type: "approval",
      taskId: "task-2",
      timeout: "P2D",
      title: "Confirm total",
      description: "Please confirm",
      currentValue: 104.5,
    });
  });

  it("defaults taskId to `<runId>:<stepId>` when not provided", async () => {
    const result = await humanCorrectBlock.execute(
      { title: "x", currentValue: null },
      fakeExecutionContext({ runId: "run-abc", stepId: "step-xyz" }),
    );
    expect(result).toMatchObject({ taskId: "run-abc:step-xyz" });
  });

  it("does not require a description", async () => {
    const result = await humanCorrectBlock.execute({ title: "x", currentValue: 1 }, fakeExecutionContext());
    expect(result).toMatchObject({ title: "x", currentValue: 1 });
  });

  it("produces output whose WaitCondition-shaped fields validate against the frozen WaitConditionApprovalSchema once a schemaVersion is stamped on (title/description/currentValue are this block's own documented extension beyond the frozen shape)", async () => {
    const result = await humanCorrectBlock.execute({ title: "x", currentValue: 1 }, fakeExecutionContext());
    expect(() => WaitConditionApprovalSchema.parse({ ...result, schemaVersion: 1 })).not.toThrow();
  });
});
