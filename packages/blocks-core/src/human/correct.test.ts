import { describe, expect, it } from "vitest";
import { humanCorrectBlock } from "./correct.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("human.correct", () => {
  it("has complete, correctly-declared metadata (capability-free, a synchronous marker — NOT wait-shaped, see this file's/correct.ts's own S9 integration note)", () => {
    expect(humanCorrectBlock.manifest.id).toBe("human.correct");
    expect(humanCorrectBlock.manifest.capabilities).toEqual([]);
    expect(humanCorrectBlock.manifest.category).toBe("human");
  });

  // S9 integration fix (root AMENDMENTS.md's dedicated entry): this used
  // to construct a WaitCondition{type:"approval"}-mimicking shape
  // (type/taskId/timeout) that @aart/engine's real wait-dispatch never
  // recognized (architecture §4.4's wait-triggering block-id list is an
  // exhaustive, verbatim 7 — human.correct is not among them) — dispatched
  // as an ordinary step, this block's run-to-completion output silently
  // never paused the workflow despite strongly implying it would. Fixed
  // to mirror human.review's honest, genuinely-synchronous shape.
  it("flags currentValue for human correction WITHOUT constructing anything wait-shaped", async () => {
    const result = await humanCorrectBlock.execute({ title: "Confirm total", description: "Please confirm", currentValue: 104.5 }, fakeExecutionContext());
    expect(result).toEqual({
      correctionRequested: true,
      title: "Confirm total",
      description: "Please confirm",
      currentValue: 104.5,
    });
    // The bug this fix closes: no "type"/"taskId"/"timeout" fields that
    // could be mistaken for @aart/engine's real WaitCondition shape.
    expect(result).not.toHaveProperty("type");
    expect(result).not.toHaveProperty("taskId");
  });

  it("does not require a description", async () => {
    const result = await humanCorrectBlock.execute({ title: "x", currentValue: 1 }, fakeExecutionContext());
    expect(result).toMatchObject({ title: "x", currentValue: 1 });
    expect((result as { description?: unknown }).description).toBeUndefined();
  });

  it("passes arbitrary currentValue shapes through unchanged (objects, arrays, primitives, null)", async () => {
    const ctx = fakeExecutionContext();
    await expect(humanCorrectBlock.execute({ title: "x", currentValue: { nested: [1, 2, 3] } }, ctx)).resolves.toMatchObject({ currentValue: { nested: [1, 2, 3] } });
    await expect(humanCorrectBlock.execute({ title: "x", currentValue: null }, ctx)).resolves.toMatchObject({ currentValue: null });
  });
});
