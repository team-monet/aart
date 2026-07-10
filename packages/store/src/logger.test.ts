import { describe, expect, it, vi } from "vitest";
import { consoleJsonSink, createLogger, noopSink, logger } from "./logger.js";

describe("createLogger", () => {
  it("defaults to the no-op sink (architecture §16: 'no-op default') — never throws, produces no output", () => {
    expect(() => logger.info("hello")).not.toThrow();
    expect(() => createLogger().error("boom")).not.toThrow();
  });

  it("emits {level, msg, time, ...context} shaped lines to a custom sink (architecture §16)", () => {
    const lines: unknown[] = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    log.info("run started", { runId: "run_1", workflowId: "wf_1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "run started", runId: "run_1", workflowId: "wf_1" });
    expect(typeof (lines[0] as { time: string }).time).toBe("string");
  });

  it.each(["debug", "info", "warn", "error"] as const)("supports the %s level", (level) => {
    const lines: Array<{ level: string }> = [];
    const log = createLogger({ sink: (line) => lines.push(line) });
    log[level]("msg");
    expect(lines[0]?.level).toBe(level);
  });

  it("merges a base context passed at creation into every line", () => {
    const lines: unknown[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), context: { workflowId: "wf_1" } });
    log.info("x", { runId: "run_1" });
    expect(lines[0]).toMatchObject({ workflowId: "wf_1", runId: "run_1" });
  });

  it("child() merges additional context, with per-call context winning on collision", () => {
    const lines: unknown[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), context: { workflowId: "wf_1" } });
    const stepLog = log.child({ runId: "run_1", stepId: "step_1" });
    stepLog.info("step done", { stepId: "override" });
    expect(lines[0]).toMatchObject({ workflowId: "wf_1", runId: "run_1", stepId: "override" });
  });

  it("noopSink is exported and does nothing when called directly", () => {
    expect(() => noopSink({ level: "info", msg: "x", time: "t" })).not.toThrow();
  });
});

describe("consoleJsonSink", () => {
  it("writes a single JSON line to console.log for info/debug", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleJsonSink({ level: "info", msg: "hi", time: "2026-07-10T00:00:00.000Z" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]![0] as string)).toMatchObject({ level: "info", msg: "hi" });
    spy.mockRestore();
  });

  it("writes a single JSON line to console.error for warn/error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleJsonSink({ level: "error", msg: "boom", time: "2026-07-10T00:00:00.000Z" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
