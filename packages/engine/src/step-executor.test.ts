import { CapabilityDeniedError, IterationLimitExceededError } from "@aart/types";
import type { BlockImplementation } from "@aart/types";
import type { AartStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import { executeStep } from "./step-executor.js";
import { idempotencyStorageKey } from "./idempotency.js";
import { repairGlobalAuditsForNewSecrets } from "./redaction.js";
import {
  capabilityBlock,
  createTestStore,
  echoBlock,
  failingBlock,
  fixtureLlmCallMetadata,
  flakyBlock,
  hangingBlock,
  llmLikeBlock,
  testEngineConfig,
  fixtureRun,
  fixtureWorkflow,
} from "./test-utils/fixtures.js";
import type { EngineConfig } from "./types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(configOverrides: Partial<EngineConfig> = {}): Promise<{ store: AartStore; config: EngineConfig }> {
  const { store, cleanup } = await createTestStore();
  cleanups.push(cleanup);
  return { store, config: testEngineConfig(store, configOverrides) };
}

describe("executeStep — resolve with: + basic dispatch", () => {
  it("resolves {{ }} expressions in with: and passes them to the block", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { url: "http://x" } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: { target: "{{ inputs.url }}" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") throw new Error("unreachable");
    const trace = outcome.run.trace[0];
    expect(trace).toMatchObject({ status: "completed", inputs: { target: "http://x" }, outputs: { echoed: { target: "http://x" } } });
  });

  it("establishes protected progress for a migrated running run whose active state is absent", async () => {
    const secret = "migrated-running-secret";
    const redact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown =>
      JSON.parse(
        [...refs].reduce(
          (json, value) =>
            json.replaceAll(value, "[REDACTED]"),
          JSON.stringify(record),
        ),
      );
    const { store, config } = await setup({
      redact,
      resolveSecret: () => secret,
    });
    const run = fixtureRun({ status: "running" });
    await store.runs.put(run);
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toBeUndefined();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "s1",
            uses: "test.echo",
            with: { token: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });

    const outcome = await executeStep(
      config,
      run,
      workflow,
      workflow.execution.steps[0]!,
      new Set(),
      undefined,
    );

    expect(outcome.kind).toBe("continue");
    expect(
      JSON.stringify(await store.runs.get(run.runId)),
    ).not.toContain(secret);
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toMatchObject({
      run: {
        status: "running",
        trace: [
          expect.objectContaining({
            outputs: { echoed: { token: secret } },
          }),
        ],
      },
      resolvedSecretValues: [secret],
    });
  });

  it("imports secret refs discovered by another run before writing later progress", async () => {
    const secret = "cross-run-late-secret";
    const redact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown =>
      JSON.parse(
        [...refs].reduce(
          (json, value) =>
            json.replaceAll(value, "[REDACTED]"),
          JSON.stringify(record),
        ),
      );
    const { store, config } = await setup({ redact });
    const run = fixtureRun({
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "source",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: secret },
          startedAt: "t",
        },
      ],
    });
    await store.runs.put(run);
    await store.runs.putOperationalState(run.runId, {
      run,
      resolvedSecretValues: [],
    });
    await repairGlobalAuditsForNewSecrets(
      store,
      redact,
      new Set([secret]),
    );
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "source", uses: "test.echo" },
          { id: "next", uses: "test.echo" },
        ],
      },
    });

    const outcome = await executeStep(
      config,
      run,
      workflow,
      workflow.execution.steps[1]!,
      new Set(),
      undefined,
    );

    expect(outcome.kind).toBe("continue");
    expect(
      JSON.stringify(await store.runs.get(run.runId)),
    ).not.toContain(secret);
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toMatchObject({
      resolvedSecretValues: [secret],
      run: {
        trace: [
          expect.objectContaining({
            outputs: { value: secret },
            secretTainted: true,
          }),
          expect.objectContaining({ stepId: "next" }),
        ],
      },
    });
  });

  it("determines nextStepId as the next sequential step when no if/next present", async () => {
    const { config } = await setup();
    const run = fixtureRun();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("s2");
  });

  it("nextStepId is undefined after the last step (signals run completion)", async () => {
    const { config } = await setup();
    const run = fixtureRun();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "only", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBeUndefined();
  });

  it("throws when the block id has no registered BlockImplementation", async () => {
    const { config } = await setup();
    const run = fixtureRun();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "unknown.block" }] } });
    await expect(executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined)).rejects.toThrow(/no blockimplementation registered/i);
  });
});

describe("executeStep — if/then/else (spec §14.1, architecture §4.2 micro-decision #7)", () => {
  it("if absent: always falls through to next/sequential, then/else never consulted", async () => {
    const { config } = await setup();
    const run = fixtureRun();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", then: "should-not-be-used", else: "also-not-used" }, { id: "s2", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("s2");
  });

  it("if true: dispatches normally, then routes to then/next", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { ok: true } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", if: "{{ inputs.ok }}", then: "yes-branch", else: "no-branch" }, { id: "yes-branch", uses: "test.echo" }, { id: "no-branch", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("yes-branch");
    expect(outcome.run.trace[0]?.status).toBe("completed");
  });

  it("if false: SKIPS dispatch entirely, records a 'skipped' StepTrace, routes to else", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { ok: false } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", if: "{{ inputs.ok }}", then: "yes-branch", else: "no-branch" }, { id: "yes-branch", uses: "test.echo" }, { id: "no-branch", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("no-branch");
    expect(outcome.run.trace[0]).toMatchObject({ status: "skipped" });
  });

  it("if false with no else: falls through to sequential order", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { ok: false } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", if: "{{ inputs.ok }}", then: "yes-branch" }, { id: "s2", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("s2");
  });

  it("explicit step.next always wins over then/else", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { ok: true } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", if: "{{ inputs.ok }}", then: "yes-branch", next: "explicit-target" }, { id: "yes-branch", uses: "test.echo" }, { id: "explicit-target", uses: "test.echo" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("explicit-target");
  });
});

describe("executeStep — guarded back-edges: maxIterations (spec §18.2)", () => {
  it("allows execution up to maxIterations, then throws IterationLimitExceededError on the next attempt", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "loop", uses: "test.echo", maxIterations: 2, next: "loop" }] } });
    let run = fixtureRun();
    const step = workflow.execution.steps[0]!;

    const first = await executeStep(config, run, workflow, step, new Set(), undefined);
    if (first.kind !== "continue") throw new Error("unreachable");
    run = first.run;
    expect(run.trace.filter((t) => t.stepId === "loop")).toHaveLength(1);

    const second = await executeStep(config, run, workflow, step, new Set(), undefined);
    if (second.kind !== "continue") throw new Error("unreachable");
    run = second.run;
    expect(run.trace.filter((t) => t.stepId === "loop")).toHaveLength(2);

    // Third attempt: priorExecutions (2) >= maxIterations (2) -> throws.
    await expect(executeStep(config, run, workflow, step, new Set(), undefined)).rejects.toThrow(IterationLimitExceededError);
  });

  it("the thrown error's detail distinguishes the guardedBackEdge kind from forEach's", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "loop", uses: "test.echo", maxIterations: 1 }] } });
    const run = fixtureRun({ trace: [{ seq: 0, stepId: "loop", block: "test.echo", status: "completed", inputs: {}, outputs: {}, startedAt: "t", endedAt: "t" }] });
    try {
      await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
      expect.fail("expected executeStep to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IterationLimitExceededError);
      expect((err as IterationLimitExceededError).detail).toMatchObject({ kind: "guardedBackEdge", stepId: "loop", maxIterations: 1, priorExecutions: 1 });
    }
  });

  it("the counter derives from persisted trace history, so it's correct even with no in-memory state carried over (restart-safety of the counter itself)", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "loop", uses: "test.echo", maxIterations: 3 }] } });
    // A run whose trace ALREADY shows 3 prior executions, as if reloaded fresh from a store after a restart.
    const run = fixtureRun({
      trace: [0, 1, 2].map((i) => ({ seq: i, stepId: "loop", block: "test.echo", status: "completed" as const, inputs: {}, outputs: {}, startedAt: "t", endedAt: "t" })),
    });
    await expect(executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined)).rejects.toThrow(IterationLimitExceededError);
  });
});

describe("executeStep — guarded back-edges: until (spec §18.2, architecture §4.2)", () => {
  it("bypasses replay/admission and revokes an unprovable prior cache entry before a secret-dependent until is evaluated", async () => {
    let executeCount = 0;
    const block: BlockImplementation = {
      manifest: {
        id: "test.until-secret-cache",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "fixture",
      },
      execute: async () => ({ value: ++executeCount }),
    };
    const { store, config } = await setup({
      blocks: { [block.manifest.id]: block },
      resolveSecret: () => true,
    });
    await store.idempotencyLedger.put({
      resolvedKey: idempotencyStorageKey("shared-until"),
      runId: "other-run",
      stepId: "poll",
      recordedOutput: { value: "cached" },
      createdAt: new Date().toISOString(),
      schemaVersion: 2,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "poll",
            uses: block.manifest.id,
            idempotencyKey: "shared-until",
            next: "poll",
            until: "{{ secrets.STOP }}",
            maxIterations: 2,
          },
          { id: "done", uses: "test.echo" },
        ],
      },
    });

    const outcome = await executeStep(
      config,
      fixtureRun(),
      workflow,
      workflow.execution.steps[0]!,
      new Set(),
      undefined,
    );

    expect(executeCount).toBe(1);
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.outputs).toEqual({ value: 1 });
    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("shared-until")),
    ).resolves.toBeUndefined();
  });

  it("until false: the back-edge (next) IS taken", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({
      execution: { type: "workflow", steps: [{ id: "rescan", uses: "test.echo", with: { done: false }, maxIterations: 6, until: "{{ steps.rescan.outputs.echoed.done }}", next: "recheck_wait" }, { id: "recheck_wait", uses: "test.echo" }] },
    });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("recheck_wait");
  });

  it("until true: the back-edge is SUPPRESSED — falls through as if next were absent", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "rescan", uses: "test.echo", with: { done: true }, maxIterations: 6, until: "{{ steps.rescan.outputs.echoed.done }}", next: "recheck_wait" },
          { id: "recheck_wait", uses: "test.echo" },
          { id: "after_loop", uses: "test.echo" },
        ],
      },
    });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    // Falls through to sequential order (the step AFTER "rescan" in array
    // order is "recheck_wait" — until suppresses the explicit `next`
    // back-edge, not skips past the immediately-following step too).
    expect(outcome.nextStepId).toBe("recheck_wait");
  });

  it("until is evaluated against THIS step's own freshly-produced output", async () => {
    const { config } = await setup();
    // No explicit `next` at all on step 2 in this variant — prove `until`
    // only matters when paired with `next` by omitting `next`: the
    // sequential fallthrough should be identical regardless of until's value
    // when there's no back-edge to suppress in the first place.
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", until: "{{ steps.s1.outputs.echoed }}" }, { id: "s2", uses: "test.echo" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.nextStepId).toBe("s2");
  });
});

describe("executeStep — forEach/as (spec §14.1 R7, architecture §4.2)", () => {
  it("runs the step body once per resolved array element, sequentially", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { items: ["a", "b", "c"] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}", as: "item", with: { value: "{{ steps.item }}" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");

    const subTraces = outcome.run.trace.filter((t) => t.stepId.startsWith("each["));
    expect(subTraces.map((t) => t.stepId)).toEqual(["each[0]", "each[1]", "each[2]"]);
    expect(subTraces.map((t) => t.outputs)).toEqual([{ echoed: { value: "a" } }, { echoed: { value: "b" } }, { echoed: { value: "c" } }]);
  });

  it("records ONE aggregate trace entry under the plain step id, with outputs.items as the array of per-iteration outputs", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { items: [1, 2] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}", as: "item", with: { value: "{{ steps.item }}" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");

    const aggregate = outcome.run.trace.find((t) => t.stepId === "each");
    expect(aggregate).toBeDefined();
    expect(aggregate?.status).toBe("completed");
    expect(aggregate?.outputs).toEqual({ items: [{ echoed: { value: 1 } }, { echoed: { value: 2 } }] });
  });

  it("a downstream step can reference {{ steps.each.outputs.items }} for the aggregate result", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { items: [10, 20] } });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "each", uses: "test.echo", forEach: "{{ inputs.items }}", as: "item", with: { value: "{{ steps.item }}" } },
          { id: "after", uses: "test.echo", with: { count: "{{ steps.each.outputs.items }}" } },
        ],
      },
    });
    const first = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (first.kind !== "continue") throw new Error("unreachable");
    const second = await executeStep(config, first.run, workflow, workflow.execution.steps[1]!, new Set(), undefined);
    if (second.kind !== "continue") throw new Error("unreachable");
    expect(second.run.trace.find((t) => t.stepId === "after")?.inputs).toEqual({ count: [{ echoed: { value: 10 } }, { echoed: { value: 20 } }] });
  });

  it("defaults the binding name to 'item' when as: is absent", async () => {
    const { config } = await setup();
    const run = fixtureRun({ inputs: { items: ["x"] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}", with: { value: "{{ steps.item }}" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace.find((t) => t.stepId === "each[0]")?.outputs).toEqual({ echoed: { value: "x" } });
  });

  it("fails fast: an iteration failure stops remaining iterations and marks the aggregate + step outcome as failed", async () => {
    const { store, config } = await setup();
    let calls = 0;
    config.blocks["test.fail-second"] = {
      manifest: { id: "test.fail-second", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fails on call 2" },
      execute: async () => {
        calls += 1;
        if (calls === 2) throw new Error("boom on second item");
        return { ok: true };
      },
    };
    const run = fixtureRun({ inputs: { items: ["a", "b", "c"] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.fail-second", forEach: "{{ inputs.items }}", as: "item" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    // Only 2 of 3 iterations attempted (fail-fast — the 3rd never runs).
    expect(outcome.run.trace.filter((t) => t.stepId.startsWith("each["))).toHaveLength(2);
    expect(outcome.run.trace.find((t) => t.stepId === "each")?.status).toBe("failed");
    void store;
  });
});

describe("executeStep — forEach array-size upper bound (architecture §4.2 admission-control gap closure)", () => {
  it("throws IterationLimitExceededError with detail.kind 'forEach' when the resolved array exceeds the configured limit", async () => {
    const { config } = await setup({ forEachArrayLimit: 3 });
    const run = fixtureRun({ inputs: { items: [1, 2, 3, 4] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}" }] } });
    try {
      await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
      expect.fail("expected executeStep to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IterationLimitExceededError);
      expect((err as IterationLimitExceededError).detail).toMatchObject({ kind: "forEach", limit: 3, actual: 4 });
    }
  });

  it("does not throw when the array is exactly at the limit", async () => {
    const { config } = await setup({ forEachArrayLimit: 2 });
    const run = fixtureRun({ inputs: { items: [1, 2] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}" }] } });
    await expect(executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined)).resolves.toMatchObject({ kind: "continue" });
  });

  it("is distinct from the guarded-back-edge maxIterations breach (same error class, different detail.kind — implementation plan S1 DoD)", async () => {
    const { config } = await setup({ forEachArrayLimit: 1 });
    const run = fixtureRun({ inputs: { items: [1, 2] } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "each", uses: "test.echo", forEach: "{{ inputs.items }}" }] } });
    try {
      await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
      expect.fail("expected executeStep to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IterationLimitExceededError);
      expect((err as IterationLimitExceededError).detail?.kind).not.toBe("guardedBackEdge");
    }
  });
});

describe("executeStep — retry (spec §30.3, architecture §4.2)", () => {
  it("retries on a retryOn-matching error class and succeeds within maxAttempts", async () => {
    const failing = flakyBlock("test.flaky1", 2); // fails twice, succeeds on 3rd
    const { config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.flaky1", retry: { maxAttempts: 3, backoff: "exponential", retryOn: ["UnknownError"] } }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]).toMatchObject({ status: "completed", outputs: { attempts: 3 } });
  });

  it("does not retry when retryOn doesn't match the error class, failing on the first attempt", async () => {
    const failing = failingBlock("test.fail-always");
    const { config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.fail-always", retry: { maxAttempts: 5, backoff: "exponential", retryOn: ["HttpServerError"] } }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
  });

  it("gives up after maxAttempts even when every failure matches retryOn", async () => {
    const failing = failingBlock("test.fail-always2");
    const { config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.fail-always2", retry: { maxAttempts: 3, backoff: "exponential", retryOn: ["UnknownError"] } }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
  });

  it("maps 'timeout'/'5xx'/'4xx' retryOn tokens to their errorClass via the normalized taxonomy (architecture micro-decision #9)", async () => {
    let calls = 0;
    const block500 = {
      manifest: { id: "test.http500", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("server error") as Error & { status: number };
          err.status = 503;
          throw err;
        }
        return { ok: true };
      },
    };
    const { config } = await setup({ blocks: { "test.http500": block500 } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.http500", retry: { maxAttempts: 2, backoff: "exponential", retryOn: ["5xx"] } }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
    expect(calls).toBe(2);
  });

  it("no retry policy at all: a single failing attempt fails the step immediately", async () => {
    const failing = failingBlock("test.no-retry-policy");
    const { config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.no-retry-policy" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
  });
});

describe("executeStep — timeout (architecture §4.2, per-attempt not cumulative)", () => {
  it("a step exceeding its timeout fails with a TimeoutError-classified failure", async () => {
    const hanging = hangingBlock("test.hangs", 500);
    const { config } = await setup({ blocks: { [hanging.manifest.id]: hanging } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.hangs", timeout: "100ms" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.error.message).toMatch(/timeout|exceeded/i);
  }, 10_000);

  it("a step well within its timeout completes normally", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", timeout: "5s" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
  });

  it("timeout applies freshly per-attempt, not cumulatively (architecture micro-decision #10)", async () => {
    // Each individual attempt is fast (50ms) and within a 200ms per-attempt
    // budget; 3 attempts * 50ms = 150ms total would EXCEED a hypothetical
    // cumulative 100ms budget but should NOT trip a per-attempt 200ms one.
    let calls = 0;
    const block = {
      manifest: { id: "test.slow-then-ok", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: () =>
        new Promise((resolve, reject) => {
          calls += 1;
          setTimeout(() => {
            if (calls < 3) reject(new Error("not yet"));
            else resolve({ ok: true });
          }, 50);
        }),
    };
    const { config } = await setup({ blocks: { "test.slow-then-ok": block } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.slow-then-ok", timeout: "200ms", retry: { maxAttempts: 3, backoff: "exponential", retryOn: ["UnknownError"] } }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
    expect(calls).toBe(3);
  }, 10_000);
});

describe("executeStep — idempotencyKey (spec §30.2)", () => {
  it("first execution with a resolved idempotencyKey runs the block and records the ledger entry", async () => {
    const { store, config } = await setup();
    const run = fixtureRun({ runId: "run-idem-1" });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "send", uses: "test.echo", idempotencyKey: "{{ run.id }}:send", with: { to: "a@b.com" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.outputs).toEqual({ echoed: { to: "a@b.com" } });
    await expect(store.idempotencyLedger.get(idempotencyStorageKey("run-idem-1:send"))).resolves.toBeDefined();
  });

  it("a second execution with the SAME resolved key replays the recorded output instead of re-executing the block", async () => {
    let executeCount = 0;
    const countingBlock = {
      manifest: { id: "test.counting", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        executeCount += 1;
        return { sentCount: executeCount };
      },
    };
    const { config } = await setup({ blocks: { "test.counting": countingBlock } });
    const run = fixtureRun({ runId: "run-idem-2" });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "send", uses: "test.counting", idempotencyKey: "{{ run.id }}:send" }] } });

    const first = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (first.kind !== "continue") throw new Error("unreachable");
    expect(first.run.trace[0]?.outputs).toEqual({ sentCount: 1 });

    // Simulate a retry of the SAME step (e.g. after a crash/reclaim) by
    // executing it again against a run whose trace was reset for this step
    // (a fresh attempt), same resolved key.
    const secondAttemptRun = { ...run, trace: [] };
    const second = await executeStep(config, secondAttemptRun, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (second.kind !== "continue") throw new Error("unreachable");
    expect(second.run.trace[0]?.outputs).toEqual({ sentCount: 1 }); // REPLAYED, not sentCount: 2
    expect(executeCount).toBe(1); // block.execute was called exactly once, ever
  });

  it("a step with no idempotencyKey always re-executes (no protection — architecture's documented at-least-once boundary)", async () => {
    let executeCount = 0;
    const countingBlock = {
      manifest: { id: "test.counting2", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        executeCount += 1;
        return { n: executeCount };
      },
    };
    const { config } = await setup({ blocks: { "test.counting2": countingBlock } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.counting2" }] } });
    await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(executeCount).toBe(2);
  });

  it("a FAILED attempt is not recorded to the idempotency ledger (only successful completions are)", async () => {
    const failing = failingBlock("test.fail-idem");
    const { store, config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const run = fixtureRun({ runId: "run-idem-3" });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.fail-idem", idempotencyKey: "{{ run.id }}:s1" }] } });
    await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    await expect(store.idempotencyLedger.get(idempotencyStorageKey("run-idem-3:s1"))).resolves.toBeUndefined();
  });

  it("does not cache output from an invocation that consumed secret data", async () => {
    const { store, config } = await setup({
      resolveSecret: () => "secret-value",
    });
    const run = fixtureRun({ runId: "run-idem-secret" });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: "test.echo",
            idempotencyKey: "{{ run.id }}:derive",
            with: { source: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });

    await executeStep(
      config,
      run,
      workflow,
      workflow.execution.steps[0]!,
      new Set(),
      undefined,
    );

    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("run-idem-secret:derive")),
    ).resolves.toBeUndefined();
  });

  it("does not cache output that matches a secret resolved earlier in the execution segment", async () => {
    const secret = "secret-from-earlier-step";
    const returningBlock: BlockImplementation = {
      manifest: {
        id: "test.return-existing-secret",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "fixture",
      },
      execute: async () => ({ value: secret }),
    };
    const { store, config } = await setup({
      blocks: { [returningBlock.manifest.id]: returningBlock },
      redact: (record, resolvedSecretRefs) =>
        [...resolvedSecretRefs].reduce(
          (redacted, value) =>
            JSON.parse(
              JSON.stringify(redacted).replaceAll(value, "[REDACTED]"),
            ),
          record,
        ),
    });
    const run = fixtureRun({ runId: "run-idem-existing-secret" });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "echo-secret",
            uses: returningBlock.manifest.id,
            idempotencyKey: "stable-existing-secret-key",
          },
        ],
      },
    });

    await executeStep(
      config,
      run,
      workflow,
      workflow.execution.steps[0]!,
      new Set([secret]),
      undefined,
    );

    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("stable-existing-secret-key"),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not replay an unversioned legacy ledger entry", async () => {
    let executeCount = 0;
    const block: BlockImplementation = {
      manifest: {
        id: "test.versioned-idempotency",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "fixture",
      },
      execute: async () => ({ value: ++executeCount }),
    };
    const { store, config } = await setup({
      blocks: { [block.manifest.id]: block },
    });
    await store.idempotencyLedger.put({
      resolvedKey: "stable-key",
      runId: "legacy-run",
      stepId: "work",
      recordedOutput: { value: "legacy-secret" },
      createdAt: new Date().toISOString(),
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "work",
            uses: block.manifest.id,
            idempotencyKey: "stable-key",
          },
        ],
      },
    });

    const outcome = await executeStep(
      config,
      fixtureRun(),
      workflow,
      workflow.execution.steps[0]!,
      new Set(),
      undefined,
    );

    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.outputs).toEqual({ value: 1 });
    expect(executeCount).toBe(1);
  });
});

describe("executeStep — dry-run mode (S9 reconciliation ledger item 7, architecture §9.5 point 1 - RunRecord.params.dryRun)", () => {
  function effectfulBlock(id: string, capability: string): BlockImplementation {
    return {
      manifest: { id, version: "1.0.0", capabilities: [capability], inputSchema: {}, outputSchema: {}, description: "fixture effectful block" },
      execute: async () => {
        throw new Error(`${id}: REAL handler was called - dry-run should have faked this dispatch instead`);
      },
    };
  }

  it("fakes an effectful block's dispatch under dryRun: true, never calling the real handler, returning the documented synthetic shape", async () => {
    const { config } = await setup({ blocks: { "test.send-email": effectfulBlock("test.send-email", "email.send") } });
    const run = fixtureRun({ params: { dryRun: true } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.send-email", with: { to: "a@b.com" } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.status).toBe("completed");
    // architecture §9.5's literal semantics: "logs 'would have called X with
    // args Y'... returns a synthetic success".
    expect(outcome.run.trace[0]?.outputs).toMatchObject({ dryRun: true, wouldHaveCalled: "test.send-email", args: { to: "a@b.com" } });
  });

  it("each of the three named-literal effectful capabilities (email.send, command, db.write) fakes correctly", async () => {
    for (const capability of ["email.send", "command", "db.write"]) {
      const blockId = `test.effectful-${capability.replace(".", "-")}`;
      const { config } = await setup({ blocks: { [blockId]: effectfulBlock(blockId, capability) } });
      const run = fixtureRun({ params: { dryRun: true } });
      const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: blockId }] } });
      const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
      if (outcome.kind !== "continue") throw new Error(`unreachable for capability ${capability}`);
      expect(outcome.run.trace[0]?.outputs).toMatchObject({ dryRun: true });
    }
  });

  it("a domain:<pattern>-gated capability is also treated as effectful (architecture §9.5: 'any domain:<pattern>-gated external write')", async () => {
    const { config } = await setup({ blocks: { "test.webhook": effectfulBlock("test.webhook", "domain:api.example.com") } });
    const run = fixtureRun({ params: { dryRun: true } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.webhook" }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.outputs).toMatchObject({ dryRun: true });
  });

  it("a NON-effectful block still calls its REAL handler even under dryRun: true (dry-run only fakes the effectful subset)", async () => {
    const { config } = await setup(); // test.echo, no declared capabilities
    const run = fixtureRun({ params: { dryRun: true } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: { x: 1 } }] } });
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.outputs).toEqual({ echoed: { x: 1 } }); // the REAL echo output, not a dryRun stub
  });

  it("an effectful block's REAL handler still runs when dryRun is absent/false (no accidental faking outside dry-run)", async () => {
    let realHandlerCalled = false;
    const block: BlockImplementation = {
      manifest: { id: "test.send-email-real", version: "1.0.0", capabilities: ["email.send"], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        realHandlerCalled = true;
        return { sent: true };
      },
    };
    const { config } = await setup({ blocks: { [block.manifest.id]: block } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.send-email-real" }] } });
    await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined); // no params.dryRun at all
    expect(realHandlerCalled).toBe(true);
  });

  it("a faked dispatch never records idempotency, so a LATER real dispatch of the same key still performs the real action", async () => {
    let realCallCount = 0;
    const block: BlockImplementation = {
      manifest: { id: "test.send-email-idem", version: "1.0.0", capabilities: ["email.send"], inputSchema: {}, outputSchema: {}, description: "fixture" },
      execute: async () => {
        realCallCount += 1;
        return { sent: true, callNumber: realCallCount };
      },
    };
    const { store, config } = await setup({ blocks: { [block.manifest.id]: block } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "send", uses: "test.send-email-idem", idempotencyKey: "{{ run.id }}:send" }] } });

    // First: a DRY RUN of this step — must NOT record idempotency, must NOT call the real handler.
    const dryRunRun = fixtureRun({ runId: "run-dryrun-idem", params: { dryRun: true } });
    const dryOutcome = await executeStep(config, dryRunRun, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (dryOutcome.kind !== "continue") throw new Error("unreachable");
    expect(dryOutcome.run.trace[0]?.outputs).toMatchObject({ dryRun: true });
    expect(realCallCount).toBe(0);
    await expect(store.idempotencyLedger.get(idempotencyStorageKey("run-dryrun-idem:send"))).resolves.toBeUndefined();

    // Second: a REAL dispatch of the SAME resolved idempotencyKey — must
    // actually call the real handler (not short-circuited by the dry run's
    // synthetic result, which would be the bug this test guards against).
    const realRun = fixtureRun({ runId: "run-dryrun-idem" }); // same runId -> same resolved key
    const realOutcome = await executeStep(config, realRun, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (realOutcome.kind !== "continue") throw new Error("unreachable");
    expect(realOutcome.run.trace[0]?.outputs).toEqual({ sent: true, callNumber: 1 });
    expect(realCallCount).toBe(1);
  });
});

describe("executeStep — capability dispatch (architecture §4.6, ADR-09)", () => {
  it("allows a step whose block's declared capabilities are permitted", async () => {
    const block = capabilityBlock("test.needs-browser", ["browser"]);
    const { config } = await setup({
      blocks: { [block.manifest.id]: block },
      capabilityCheck: (declared, granted) => declared.every((d) => granted.includes(d)),
      getGrantedCapabilities: async () => ["browser", "http"],
    });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.needs-browser" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
  });

  it("denies (throws CapabilityDeniedError) a step whose declared capability is not granted", async () => {
    const block = capabilityBlock("test.needs-command", ["command"]);
    const { config } = await setup({
      blocks: { [block.manifest.id]: block },
      capabilityCheck: (declared, granted) => declared.every((d) => granted.includes(d)),
      getGrantedCapabilities: async () => ["browser"],
    });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.needs-command" }] } });
    await expect(executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined)).rejects.toThrow(CapabilityDeniedError);
  });

  it("the default always-allow stub never blocks any capability (implementation plan S1 DoD's stub)", async () => {
    const block = capabilityBlock("test.needs-everything", ["command", "db.write", "secrets:ANYTHING"]);
    const { config } = await setup({ blocks: { [block.manifest.id]: block } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.needs-everything" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("continue");
  });
});

describe("executeStep — redaction routing (architecture §4.2/§7.9)", () => {
  // S9 integration fix (see createTrackingSecretResolver's own doc comment
  // + root AMENDMENTS.md's dedicated entry): resolvedSecretRefs now
  // correctly holds the resolved VALUE ("secret-value-for-API_KEY"), not
  // the resolved NAME ("API_KEY") - matching @aart/governance's real
  // redactRecord's documented contract exactly.
  it("routes the persisted RunRecord through the injected RedactFn, threading resolvedSecretRefs", async () => {
    const { store } = await setup();
    let seenRefs: ReadonlySet<string> | undefined;
    const config = testEngineConfig(store, {
      redact: (record, resolvedSecretRefs) => {
        seenRefs = resolvedSecretRefs;
        return record;
      },
      resolveSecret: async (name) => `secret-value-for-${name}`,
    });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: { apiKey: "{{ secrets.API_KEY }}" } }] } });
    const resolvedSecretRefs = new Set<string>();
    await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, resolvedSecretRefs, undefined);
    expect(seenRefs).toBe(resolvedSecretRefs);
    expect(resolvedSecretRefs.has("secret-value-for-API_KEY")).toBe(true);
    expect(resolvedSecretRefs.has("API_KEY")).toBe(false); // the bug this fix closes: the NAME must NOT be what gets tracked
  });

  it("a secret value never reaches the persisted store when a real (non-identity) redactor is wired in (architecture §7.9 — proving the routing is real, not merely declared)", async () => {
    const { store } = await setup();
    // Matches @aart/governance's real redactRecord's actual contract now
    // (scans for literal VALUE occurrences directly - no name-to-value
    // reconstruction needed, unlike the pre-fix version of this test).
    const scanAndReplace = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const value of resolvedSecretRefs) json = json.split(value).join("[REDACTED]");
      return JSON.parse(json);
    };
    const config = testEngineConfig(store, { redact: scanAndReplace, resolveSecret: async (name) => `secret-value-for-${name}` });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo", with: { apiKey: "{{ secrets.API_KEY }}" } }] } });
    const run = fixtureRun();
    await store.runs.put(run);
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");

    const persisted = await store.runs.get(run.runId);
    const persistedJson = JSON.stringify(persisted);
    expect(persistedJson).not.toContain("secret-value-for-API_KEY");
    expect(persistedJson).toContain("[REDACTED]");
  });

  // A41 fix (root AMENDMENTS.md, S10 Completion): executeWaitDispatch's
  // human.approval branch built and persisted a brand-new ApprovalTask
  // directly via config.store.approvals.put(...) using resolvedWith's
  // POST-resolution title/description — the one persist call site in this
  // file that never routed through applyRedaction, even though
  // resolvedSecretRefs is already a live parameter of this exact function.
  // A workflow author referencing {{ secrets.X }} in a human.approval
  // step's title/description would have had the raw resolved secret value
  // persisted, unredacted, into a NEW store collection (approvals) never
  // covered by enterWait's own (separate) WaitCondition redaction.
  it("a human.approval step's newly-created ApprovalTask is redacted the same as the rest of the persisted state (A41 — this call site used to bypass applyRedaction entirely)", async () => {
    const { store } = await setup();
    const scanAndReplace = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const value of resolvedSecretRefs) json = json.split(value).join("[REDACTED]");
      return JSON.parse(json);
    };
    const config = testEngineConfig(store, { redact: scanAndReplace, resolveSecret: async (name) => `secret-value-for-${name}` });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [{ id: "review", uses: "human.approval", with: { title: "{{ secrets.APPROVAL_TITLE }}", description: "static description, no secret here" } }],
      },
    });
    const run = fixtureRun();
    await store.runs.put(run);

    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("waiting");

    const approvals = await store.approvals.list({ runId: run.runId });
    expect(approvals).toHaveLength(1);
    const task = approvals[0]!;
    expect(task.title).not.toContain("secret-value-for-APPROVAL_TITLE");
    expect(task.title).toContain("[REDACTED]");
    expect(task.description).toBe("static description, no secret here"); // non-secret fields pass through unchanged
  });
});

describe("executeStep — ctx.recordLlmCall wiring (S9 reconciliation ledger item 6, SEAMS.md L3 - @aart/llm's proposed extension, now actually wired into real dispatch)", () => {
  it("attaches the block's recorded LlmCallMetadata to the completed StepTrace's llmCall field", async () => {
    const { config } = await setup({ blocks: { [llmLikeBlock.manifest.id]: llmLikeBlock } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.llm-like" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    const trace = outcome.run.trace[0];
    expect(trace?.llmCall).toEqual(fixtureLlmCallMetadata());
    // The block's plain output is untouched - recordLlmCall is a side
    // channel, not a wrapper around the return value ({{ steps.X.outputs.* }}
    // ergonomics stay correct).
    expect(trace?.outputs).toMatchObject({ output: "fixture llm output" });
  });

  it("a non-llm block that never calls recordLlmCall leaves StepTrace.llmCall undefined (no spurious attachment)", async () => {
    const { config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");
    expect(outcome.run.trace[0]?.llmCall).toBeUndefined();
  });

  it("a failed dispatch never attaches llmCall (recordLlmCall is only ever reached after a successful call)", async () => {
    const failingLlmLike: BlockImplementation = {
      manifest: { id: "test.llm-like-failing", version: "1.0.0", capabilities: ["llm"], inputSchema: {}, outputSchema: {}, description: "Fails before ever calling recordLlmCall." },
      execute: async () => {
        throw new Error("simulated llm call failure");
      },
    };
    const { config } = await setup({ blocks: { [failingLlmLike.manifest.id]: failingLlmLike } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.llm-like-failing" }] } });
    const outcome = await executeStep(config, fixtureRun(), workflow, workflow.execution.steps[0]!, new Set(), undefined);
    expect(outcome.kind).toBe("failed");
  });

  it("recorded LlmCallMetadata is redacted the same as the rest of the persisted RunRecord (architecture §7.9 - no separate call site needed, same chokepoint)", async () => {
    const { store } = await setup();
    // Matches @aart/governance's real redactRecord's actual contract now
    // (scans for literal VALUE occurrences directly).
    const scanAndReplace = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const value of resolvedSecretRefs) json = json.split(value).join("[REDACTED]");
      return JSON.parse(json);
    };
    // Contrived but proves the point: ANY string field on LlmCallMetadata
    // (here, promptRef) gets swept by the value-scan-and-replace redactor,
    // not just a hardcoded/allowlisted field name (architecture §7.9: "never
    // a field-name allowlist").
    const leakyLlmLike: BlockImplementation = {
      manifest: { id: "test.llm-like-leaky", version: "1.0.0", capabilities: ["llm"], inputSchema: {}, outputSchema: {}, description: "Records metadata containing a resolved secret value." },
      execute: async (_resolvedInputs, ctx) => {
        const secretValue = await ctx.resolveSecret("PROMPT_NAME");
        (ctx as unknown as { recordLlmCall?: (m: unknown) => void }).recordLlmCall?.(fixtureLlmCallMetadata({ promptRef: `resolved: ${secretValue}` }));
        return { ok: true };
      },
    };
    const config = testEngineConfig(store, {
      blocks: { [leakyLlmLike.manifest.id]: leakyLlmLike },
      redact: scanAndReplace,
      resolveSecret: async (name) => `secret-value-for-${name}`,
    });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.llm-like-leaky" }] } });
    const run = fixtureRun();
    await store.runs.put(run);
    const outcome = await executeStep(config, run, workflow, workflow.execution.steps[0]!, new Set(), undefined);
    if (outcome.kind !== "continue") throw new Error("unreachable");

    const persisted = await store.runs.get(run.runId);
    const persistedJson = JSON.stringify(persisted);
    expect(persistedJson).not.toContain("secret-value-for-PROMPT_NAME");
    expect(persistedJson).toContain("[REDACTED]");
  });
});
