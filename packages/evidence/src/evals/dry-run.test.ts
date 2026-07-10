import { describe, expect, it } from "vitest";
import { ConnectorFakeRegistry, isEffectfulCapability, runStepsWithDryRun, type EvalStepDefinition } from "./dry-run.js";

describe("isEffectfulCapability (architecture §9.5)", () => {
  it("matches the default effectful set (email.send, command, db.write)", () => {
    expect(isEffectfulCapability("email.send")).toBe(true);
    expect(isEffectfulCapability("command")).toBe(true);
    expect(isEffectfulCapability("db.write")).toBe(true);
  });

  it("matches any domain:<pattern>-gated capability by family", () => {
    expect(isEffectfulCapability("domain:api.github.com")).toBe(true);
  });

  it("does not match a non-effectful capability like browser or db.read", () => {
    expect(isEffectfulCapability("browser")).toBe(false);
    expect(isEffectfulCapability("db.read")).toBe(false);
  });

  it("honors a caller-supplied effectfulCapabilities override", () => {
    expect(isEffectfulCapability("browser", ["browser"])).toBe(true);
    expect(isEffectfulCapability("email.send", ["browser"])).toBe(false);
  });
});

describe("ConnectorFakeRegistry.register (architecture §9.5 point 2)", () => {
  it("structurally REQUIRES a fake for an effectful capability — registering without one throws immediately", () => {
    const registry = new ConnectorFakeRegistry();
    expect(() => registry.register({ blockId: "email.send", capability: "email.send", real: () => ({}) })).toThrow(/registered no fake/);
  });

  it("allows a non-effectful block to register with no fake at all", () => {
    const registry = new ConnectorFakeRegistry();
    expect(() => registry.register({ blockId: "http.request", capability: "http", real: () => ({}) })).not.toThrow();
    expect(registry.has("http.request")).toBe(true);
  });

  it("get()/has() reflect registered entries", () => {
    const registry = new ConnectorFakeRegistry();
    expect(registry.has("x")).toBe(false);
    registry.register({ blockId: "x", capability: "browser", real: () => 1 });
    expect(registry.has("x")).toBe(true);
    expect(registry.get("x")?.capability).toBe("browser");
  });
});

describe("runStepsWithDryRun — sequential execution + prior-output threading", () => {
  it("threads step outputs forward so a later step's `with` function can read an earlier step's output", async () => {
    const fakes = new ConnectorFakeRegistry();
    fakes.register({ blockId: "data.parse", capability: "data", real: (input: { raw: string }) => ({ parsed: input.raw.toUpperCase() }) });
    fakes.register({ blockId: "data.pick", capability: "data", real: (input: { value: string }) => ({ picked: input.value }) });

    const steps: EvalStepDefinition[] = [
      { id: "parse", block: "data.parse", with: { raw: "hello" } },
      { id: "pick", block: "data.pick", with: (prior) => ({ value: (prior.parse as { parsed: string }).parsed }) },
    ];

    const { outputs, trace } = await runStepsWithDryRun(steps, { dryRun: false, fakes });
    expect(outputs.pick).toEqual({ picked: "HELLO" });
    expect(trace.map((t) => t.stepId)).toEqual(["parse", "pick"]);
    expect(trace.every((t) => !t.usedFake)).toBe(true);
  });

  it("throws a clear error when a step references a block with no registered ConnectorFakeEntry", async () => {
    const fakes = new ConnectorFakeRegistry();
    await expect(runStepsWithDryRun([{ id: "s1", block: "unknown.block" }], { dryRun: false, fakes })).rejects.toThrow(/no ConnectorFakeRegistry entry/);
  });

  it("throws when dryRun selects the fake path but no fake was registered — impossible in practice since register() enforces it, but proves the run-time guard exists independently", async () => {
    const fakes = new ConnectorFakeRegistry();
    // Registering a NON-effectful capability doesn't require a fake, but if
    // the caller passes a custom effectfulCapabilities list that retroactively
    // treats it as effectful, runStepsWithDryRun must still fail loudly
    // rather than silently calling `.real` in dry-run.
    fakes.register({ blockId: "custom.write", capability: "custom", real: () => ({}) });
    await expect(
      runStepsWithDryRun([{ id: "s1", block: "custom.write" }], { dryRun: true, fakes, effectfulCapabilities: ["custom"] }),
    ).rejects.toThrow(/no fake handler/);
  });
});

describe("THE REQUIRED TEST (architecture §9.5, this session's DoD: \"the single most important test in this session\") — dry-run + connector fakes, side-effect-safe execution end-to-end", () => {
  it("a fixture workflow with an email.send-shaped effectful step, run in dry-run mode: (a) no real send occurs — the fake records a synthetic result instead, and (b) a downstream step depending on email.send's output shape still receives a plausible synthetic result and behaves correctly", async () => {
    let realEmailSendCallCount = 0;

    const fakes = new ConnectorFakeRegistry();
    fakes.register({
      blockId: "email.send",
      capability: "email.send",
      real: (input: { to: string }) => {
        realEmailSendCallCount++;
        throw new Error(`REAL email.send was invoked with to="${input.to}" — this must NEVER happen in dry-run mode`);
      },
      fake: (input: { to: string }) => ({ messageId: "fake-msg-001", accepted: true, wouldHaveSentTo: input.to }),
    });
    fakes.register({
      blockId: "log.record",
      capability: "log", // NOT effectful — must always use `.real`, even in dry-run.
      real: (input: { messageId: string }) => ({ logged: true, loggedMessageId: input.messageId }),
    });

    const steps: EvalStepDefinition[] = [
      { id: "send_email", block: "email.send", with: { to: "broker@example.com" } },
      {
        id: "log_result",
        block: "log.record",
        with: (priorOutputs) => ({ messageId: (priorOutputs.send_email as { messageId: string }).messageId }),
      },
    ];

    const { outputs, trace } = await runStepsWithDryRun(steps, { dryRun: true, fakes });

    // (a) no real send occurred.
    expect(realEmailSendCallCount).toBe(0);
    const sendTrace = trace.find((t) => t.stepId === "send_email")!;
    expect(sendTrace.usedFake).toBe(true);
    expect((outputs.send_email as { wouldHaveSentTo: string }).wouldHaveSentTo).toBe("broker@example.com");
    expect((outputs.send_email as { accepted: boolean }).accepted).toBe(true); // "would have sent" synthetic success, recorded instead of a real send

    // (b) the downstream step still received a plausible synthetic result
    // (the fake's messageId) and behaved correctly on it.
    const logOutput = outputs.log_result as { logged: boolean; loggedMessageId: string };
    expect(logOutput.logged).toBe(true);
    expect(logOutput.loggedMessageId).toBe("fake-msg-001");

    // Sanity: a NON-effectful step is not faked, even inside a dry-run.
    const logTrace = trace.find((t) => t.stepId === "log_result")!;
    expect(logTrace.usedFake).toBe(false);
  });

  it("the SAME fixture, run with dryRun: false, DOES invoke the real handler (proving the dry-run test above is meaningful, not vacuously true because the real handler was unreachable by construction)", async () => {
    let realEmailSendCallCount = 0;
    const fakes = new ConnectorFakeRegistry();
    fakes.register({
      blockId: "email.send",
      capability: "email.send",
      real: (input: { to: string }) => {
        realEmailSendCallCount++;
        return { messageId: "real-msg-999", accepted: true };
      },
      fake: () => ({ messageId: "fake-msg-001", accepted: true }),
    });

    const { trace } = await runStepsWithDryRun([{ id: "send_email", block: "email.send", with: { to: "x@example.com" } }], {
      dryRun: false,
      fakes,
    });

    expect(realEmailSendCallCount).toBe(1);
    expect(trace[0]?.usedFake).toBe(false);
  });
});
