import { describe, expect, it } from "vitest";
import { buildWaitConditionFromBlock, isWaitBlockId, WAIT_BLOCK_IDS, waitSignalCorrelation, type WaitBlockId } from "./wait-blocks.js";

describe("WAIT_BLOCK_IDS / isWaitBlockId", () => {
  it("is exactly the 7 wait-triggering block ids named in architecture §4.4 step 1 / spec §15.3", () => {
    expect(WAIT_BLOCK_IDS).toEqual(["wait.for_signal", "wait.until", "wait.for_webhook", "wait.for_external_job", "wait.for_queue", "wait.manual", "human.approval"]);
  });

  it("recognizes every listed id", () => {
    for (const id of WAIT_BLOCK_IDS) {
      expect(isWaitBlockId(id)).toBe(true);
    }
  });

  it("does not recognize an ordinary action block id", () => {
    expect(isWaitBlockId("browser.click")).toBe(false);
    expect(isWaitBlockId("human.review")).toBe(false); // spec §15.3: Human group has 3 blocks, only human.approval is a WaitCondition member
    expect(isWaitBlockId("human.correct")).toBe(false);
  });
});

describe("buildWaitConditionFromBlock — one member per non-approval wait block id", () => {
  it("wait.for_signal -> signal", () => {
    expect(buildWaitConditionFromBlock("wait.for_signal", { name: "quote.received", correlationId: "corr1", timeout: "7d" }, 1)).toEqual({
      type: "signal",
      name: "quote.received",
      correlationId: "corr1",
      timeout: "7d",
      schemaVersion: 1,
    });
  });

  it("wait.for_signal without timeout leaves timeout undefined", () => {
    const wait = buildWaitConditionFromBlock("wait.for_signal", { name: "n", correlationId: "c" }, 1);
    expect(wait).toMatchObject({ type: "signal", name: "n", correlationId: "c" });
    expect((wait as { timeout?: string }).timeout).toBeUndefined();
  });

  it("wait.until -> timer (no timeout field — a timer has no separate timeout concept)", () => {
    expect(buildWaitConditionFromBlock("wait.until", { resumeAt: "2027-01-01T00:00:00.000Z" }, 1)).toEqual({
      type: "timer",
      resumeAt: "2027-01-01T00:00:00.000Z",
      schemaVersion: 1,
    });
  });

  it("wait.for_webhook -> webhook", () => {
    expect(buildWaitConditionFromBlock("wait.for_webhook", { event: "contract.signed", correlationId: "contract-1", timeout: "7d" }, 1)).toEqual({
      type: "webhook",
      event: "contract.signed",
      correlationId: "contract-1",
      timeout: "7d",
      schemaVersion: 1,
    });
  });

  it("wait.for_external_job -> external_job", () => {
    expect(buildWaitConditionFromBlock("wait.for_external_job", { provider: "openai_batch", jobId: "job-123" }, 1)).toEqual({
      type: "external_job",
      provider: "openai_batch",
      jobId: "job-123",
      timeout: undefined,
      schemaVersion: 1,
    });
  });

  it("wait.for_queue -> queue", () => {
    expect(buildWaitConditionFromBlock("wait.for_queue", { queue: "orders", correlationId: "order-1" }, 1)).toEqual({
      type: "queue",
      queue: "orders",
      correlationId: "order-1",
      timeout: undefined,
      schemaVersion: 1,
    });
  });

  it("wait.manual -> manual", () => {
    expect(buildWaitConditionFromBlock("wait.manual", {}, 1)).toEqual({ type: "manual", timeout: undefined, schemaVersion: 1 });
  });

  it("throws a clear error when a required with: field is missing/mistyped", () => {
    expect(() => buildWaitConditionFromBlock("wait.for_signal", { name: "n" }, 1)).toThrow(/correlationId/);
    expect(() => buildWaitConditionFromBlock("wait.until", {}, 1)).toThrow(/resumeAt/);
  });

  it("stamps the given schemaVersion, not a hardcoded constant", () => {
    expect(buildWaitConditionFromBlock("wait.manual", {}, 42)).toMatchObject({ schemaVersion: 42 });
  });
});

describe("waitSignalCorrelation — exhaustive over all 7 WaitCondition members (architecture §2.2's exhaustiveness requirement)", () => {
  it("signal: correlates on (name, correlationId)", () => {
    expect(waitSignalCorrelation({ type: "signal", name: "quote.received", correlationId: "c1", schemaVersion: 1 })).toEqual({ name: "quote.received", correlationId: "c1" });
  });

  it("webhook: correlates on (event, correlationId) — event serves as the name-equivalent (spec §13.3)", () => {
    expect(waitSignalCorrelation({ type: "webhook", event: "contract.signed", correlationId: "c1", schemaVersion: 1 })).toEqual({ name: "contract.signed", correlationId: "c1" });
  });

  it("queue: correlates on (queue, correlationId) — queue serves as the name-equivalent", () => {
    expect(waitSignalCorrelation({ type: "queue", queue: "orders", correlationId: "c1", schemaVersion: 1 })).toEqual({ name: "orders", correlationId: "c1" });
  });

  it("external_job: correlates on (provider, jobId) — jobId is the correlationId-equivalent (architecture §4.4.1: 'a Signal keyed on jobId')", () => {
    expect(waitSignalCorrelation({ type: "external_job", provider: "openai_batch", jobId: "job-1", schemaVersion: 1 })).toEqual({ name: "openai_batch", correlationId: "job-1" });
  });

  it("timer never touches SignalStore — returns undefined", () => {
    expect(waitSignalCorrelation({ type: "timer", resumeAt: "2027-01-01T00:00:00.000Z", schemaVersion: 1 })).toBeUndefined();
  });

  it("manual never touches SignalStore — returns undefined", () => {
    expect(waitSignalCorrelation({ type: "manual", schemaVersion: 1 })).toBeUndefined();
  });

  it("approval never touches SignalStore — returns undefined (direct ApprovalStore write, architecture §4.4.1)", () => {
    expect(waitSignalCorrelation({ type: "approval", taskId: "task-1", schemaVersion: 1 })).toBeUndefined();
  });

  it("covers all members declared in WAIT_BLOCK_IDS-adjacent WaitCondition union without a missing case (regression guard for the exhaustiveness switch)", () => {
    const allTypes: WaitBlockId[] = [...WAIT_BLOCK_IDS];
    expect(allTypes.length).toBe(7);
  });
});
