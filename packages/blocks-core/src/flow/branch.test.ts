import { describe, expect, it } from "vitest";
import { flowBranchBlock } from "./branch.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("flow.branch", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(flowBranchBlock.manifest.id).toBe("flow.branch");
    expect(flowBranchBlock.manifest.capabilities).toEqual([]);
    expect(flowBranchBlock.manifest.category).toBe("flow");
  });

  it("matches the first case whose `when` deep-equals `value`, even with a duplicate later", async () => {
    const result = await flowBranchBlock.execute(
      {
        value: "b",
        cases: [
          { when: "a", to: "step_a" },
          { when: "b", to: "step_b" },
          { when: "b", to: "step_b_again" },
        ],
        default: "fallback",
      },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ to: "step_b", matched: true });
  });

  it("falls through to `default` when no case matches", async () => {
    const result = await flowBranchBlock.execute(
      {
        value: "z",
        cases: [
          { when: "a", to: "step_a" },
          { when: "b", to: "step_b" },
        ],
        default: "fallback",
      },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ to: "fallback", matched: false });
  });

  it("falls through to null when no case matches and no default is given", async () => {
    const result = await flowBranchBlock.execute({ value: "z", cases: [{ when: "a", to: "step_a" }] }, fakeExecutionContext());
    expect(result).toEqual({ to: null, matched: false });
  });

  it("matches structurally via deep equality, not reference identity", async () => {
    const result = await flowBranchBlock.execute(
      {
        value: { status: "ok", code: 200 },
        cases: [{ when: { status: "ok", code: 200 }, to: "continue" }],
      },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ to: "continue", matched: true });
  });
});
