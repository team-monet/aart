import { describe, expect, it } from "vitest";
import { humanReviewBlock } from "./review.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("human.review", () => {
  it("has complete, correctly-declared metadata (capability-free, non-blocking marker)", () => {
    expect(humanReviewBlock.manifest.id).toBe("human.review");
    expect(humanReviewBlock.manifest.capabilities).toEqual([]);
    expect(humanReviewBlock.manifest.category).toBe("human");
  });

  it("returns a reviewRequested marker carrying the flagged data through unchanged", async () => {
    const result = await humanReviewBlock.execute(
      { title: "Extracted terms", description: "please double-check", data: { rate: 0.05 } },
      fakeExecutionContext(),
    );
    expect(result).toEqual({ reviewRequested: true, title: "Extracted terms", description: "please double-check", data: { rate: 0.05 } });
  });

  it("does not require a description", async () => {
    const result = await humanReviewBlock.execute({ title: "x", data: 1 }, fakeExecutionContext());
    expect(result).toMatchObject({ reviewRequested: true, title: "x", data: 1 });
  });

  it("resolves synchronously without pausing (no wait-shaped output)", async () => {
    const result = (await humanReviewBlock.execute({ title: "x", data: null }, fakeExecutionContext())) as Record<string, unknown>;
    expect(result).not.toHaveProperty("type");
  });
});
