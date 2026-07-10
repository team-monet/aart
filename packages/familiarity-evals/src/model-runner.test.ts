import { describe, expect, it } from "vitest";
import { createFakeModelRunner } from "./model-runner.js";
import type { AuthoringTask } from "./types.js";

const task: AuthoringTask = { id: "task1", prompt: "do a thing", expectedBlocks: ["browser.goto"] };

describe("createFakeModelRunner — the fake-model adapter (this session's DoD: fully offline-testable)", () => {
  it("returns the scripted response for a single-response script", async () => {
    const runner = createFakeModelRunner({ task1: { rawOutput: "raw", workflow: { id: "w" } } });
    const result = await runner(task, []);
    expect(result).toEqual({ rawOutput: "raw", workflow: { id: "w" } });
  });

  it("cycles through an array of scripted responses, one per call (round)", async () => {
    const runner = createFakeModelRunner({
      task1: [
        { rawOutput: "attempt 1 (bad)", workflow: { bad: true } },
        { rawOutput: "attempt 2 (good)", workflow: { good: true } },
      ],
    });
    await expect(runner(task, [])).resolves.toEqual({ rawOutput: "attempt 1 (bad)", workflow: { bad: true } });
    await expect(runner(task, [])).resolves.toEqual({ rawOutput: "attempt 2 (good)", workflow: { good: true } });
  });

  it("repeats the LAST scripted entry once the array is exhausted, rather than throwing", async () => {
    const runner = createFakeModelRunner({ task1: [{ rawOutput: "only" }] });
    await runner(task, []);
    await expect(runner(task, [])).resolves.toEqual({ rawOutput: "only", workflow: undefined });
    await expect(runner(task, [])).resolves.toEqual({ rawOutput: "only", workflow: undefined });
  });

  it("throws a clear error for a task with no scripted response at all", async () => {
    const runner = createFakeModelRunner({});
    await expect(runner(task, [])).rejects.toThrow(/no scripted response/);
  });

  it("tracks call counts independently per task id", async () => {
    const runner = createFakeModelRunner({
      task1: [{ rawOutput: "t1-r1" }, { rawOutput: "t1-r2" }],
      task2: [{ rawOutput: "t2-r1" }],
    });
    const task2: AuthoringTask = { id: "task2", prompt: "x", expectedBlocks: [] };
    await expect(runner(task, [])).resolves.toMatchObject({ rawOutput: "t1-r1" });
    await expect(runner(task2, [])).resolves.toMatchObject({ rawOutput: "t2-r1" });
    await expect(runner(task, [])).resolves.toMatchObject({ rawOutput: "t1-r2" });
  });
});
