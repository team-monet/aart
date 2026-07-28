import { describe, expect, it, vi } from "vitest";

vi.mock("isolated-vm", () => {
  throw new Error("@aart/evidence must not link isolated-vm during import");
});

describe("@aart/evidence import boundary", () => {
  it("loads report and correction exports without linking the engine sandbox", async () => {
    const evidence = await import("./index.js");

    expect(evidence.renderMarkdown).toBeTypeOf("function");
    expect(evidence.updateRunOutput).toBeTypeOf("function");
  });
});
