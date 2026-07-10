import { describe, expect, it } from "vitest";
import { AUTHORING_TASK_CATALOG } from "./catalog.js";

describe("AUTHORING_TASK_CATALOG — grounded in spec §32.3's recipe catalog (this session's DoD: authoring-task suite definitions)", () => {
  it("has at least 6 tasks, covering a meaningful slice of spec §32.3's 9-item recipe catalog", () => {
    expect(AUTHORING_TASK_CATALOG.length).toBeGreaterThanOrEqual(6);
  });

  it("every task has a unique id", () => {
    const ids = AUTHORING_TASK_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task has a non-empty prompt and at least one expected block", () => {
    for (const task of AUTHORING_TASK_CATALOG) {
      expect(task.prompt.length).toBeGreaterThan(0);
      expect(task.expectedBlocks.length).toBeGreaterThan(0);
    }
  });

  it("every task is tagged back to the spec §32.3 recipe it exercises", () => {
    for (const task of AUTHORING_TASK_CATALOG) {
      expect(task.tags?.some((t) => t.startsWith("recipe:"))).toBe(true);
    }
  });
});
