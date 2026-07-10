import { describe, expect, it } from "vitest";
import { flowFailBlock, FlowFailError } from "./fail.js";
import { fakeExecutionContext } from "../test-support/fake-context.js";

describe("flow.fail", () => {
  it("has complete, correctly-declared metadata", () => {
    expect(flowFailBlock.manifest.id).toBe("flow.fail");
    expect(flowFailBlock.manifest.capabilities).toEqual([]);
    expect(flowFailBlock.manifest.category).toBe("flow");
  });

  it("always throws FlowFailError with the given message", async () => {
    await expect(flowFailBlock.execute({ message: "unsupported input shape" }, fakeExecutionContext())).rejects.toThrow(FlowFailError);
    await expect(flowFailBlock.execute({ message: "unsupported input shape" }, fakeExecutionContext())).rejects.toThrow(
      "unsupported input shape",
    );
  });

  it("carries the given detail on the thrown error", async () => {
    let caught: unknown;
    try {
      await flowFailBlock.execute({ message: "boom", detail: { code: 42 } }, fakeExecutionContext());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FlowFailError);
    expect((caught as FlowFailError).message).toBe("boom");
    expect((caught as FlowFailError).detail).toEqual({ code: 42 });
  });
});
