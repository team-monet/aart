import type { AartStore } from "@aart/store";
import { ConcurrencyRejectedError } from "@aart/types";
import type { Field } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import { cancelRun, executeRun, triggerRun } from "./run-lifecycle.js";
import { createTestStore, failingBlock, fixtureTrigger, testEngineConfig, fixtureWorkflow } from "./test-utils/fixtures.js";
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

function redactResolvedValues(record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown {
  const replacements = [...resolvedSecretRefs];
  const redactString = (value: string): string =>
    replacements.reduce((current, secret, index) => current.replaceAll(secret, `[REDACTED:secret-${index + 1}]`), value);
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if ((typeof value === "number" || typeof value === "boolean") && replacements.includes(String(value))) {
      return `[REDACTED:secret-${replacements.indexOf(String(value)) + 1}]`;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [redactString(key), visit(nested)]));
    }
    return value;
  };
  return visit(record);
}

describe("triggerRun — run intake (architecture §4.3)", () => {
  it("creates a pending RunRecord and enqueues it to job_queue", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow();
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { url: "http://x" } });
    expect(run.status).toBe("pending");
    expect(run.workflowId).toBe(workflow.id);
    expect(run.inputs).toEqual({ url: "http://x" });

    const persisted = await store.runs.get(run.runId);
    expect(persisted).toEqual(run);
    const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimable.map((c) => c.runId)).toContain(run.runId);
  });

  it("captures approved/approvalMode from the input, defaulting to approved:true/dev", async () => {
    const { config } = await setup();
    const run = await triggerRun(config, { workflow: fixtureWorkflow(), trigger: fixtureTrigger(), inputs: {} });
    expect(run.approved).toBe(true);
    expect(run.approvalMode).toBe("dev");

    const runProd = await triggerRun(config, { workflow: fixtureWorkflow(), trigger: fixtureTrigger(), inputs: {}, approved: false, approvalMode: "production" });
    expect(runProd.approved).toBe(false);
    expect(runProd.approvalMode).toBe("production");
  });

  it("stamps this engine's schemaVersion on the created RunRecord", async () => {
    const { config } = await setup();
    const run = await triggerRun(config, { workflow: fixtureWorkflow(), trigger: fixtureTrigger(), inputs: {} });
    expect(run.schemaVersion).toBe(1);
  });

  it("allow (default, no concurrency declared): two triggers of the same workflow both proceed independently", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-allow" });
    const a = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const b = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    expect(a.runId).not.toBe(b.runId);
    const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimable.map((c) => c.runId)).toEqual(expect.arrayContaining([a.runId, b.runId]));
  });

  it("queue: a second trigger with the same key is created pending but NOT enqueued (held behind the first)", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-queue", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    const first = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    expect(first.status).toBe("pending");
    const second = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    expect(second.status).toBe("pending");
    expect(second.params?.waitingOnConcurrency).toBe(true);
    expect(second.params?.concurrencyKey).toBe("case-1");
    expect(second.params?.concurrencyKeyFormat).toBeUndefined();

    const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimable.map((c) => c.runId)).toContain(first.runId);
    expect(claimable.map((c) => c.runId)).not.toContain(second.runId);
  });

  it("ignores caller-supplied concurrency bookkeeping and enforces the workflow policy", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-reserved-params", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" } });
    const injectedParams = {
      concurrencyKey: "attacker-key",
      concurrencyKeyFormat: "sha256-v1",
      waitingOnConcurrency: true,
      keep: "caller-value",
    };

    const first = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { caseId: "case-1" },
      params: injectedParams,
    });
    const second = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { caseId: "case-1" },
      params: injectedParams,
    });

    expect(first.params).toMatchObject({ concurrencyKey: "case-1", keep: "caller-value" });
    expect(first.params?.concurrencyKeyFormat).toBeUndefined();
    expect(first.params?.waitingOnConcurrency).toBeUndefined();
    expect(second.params).toMatchObject({ concurrencyKey: "case-1", waitingOnConcurrency: true, keep: "caller-value" });
    expect(second.params?.concurrencyKeyFormat).toBeUndefined();

    const claimable = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimable.map((entry) => entry.runId)).toContain(first.runId);
    expect(claimable.map((entry) => entry.runId)).not.toContain(second.runId);
  });

  it("keeps newly created runs visible to pre-fingerprint intake during a rolling upgrade", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      id: "wf-rolling-upgrade",
      concurrency: { key: "{{ inputs.caseId }}", policy: "queue" },
    });

    await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });

    const candidates = await store.runs.list({ workflowId: workflow.id });
    // This is the exact comparison used by the pre-change intake path.
    expect(candidates.some((run) => run.params?.concurrencyKey === "case-1")).toBe(true);
  });

  it("cancel_existing: triggering cancels the prior non-terminal run for the same key (skip-recording applies)", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-cancel", concurrency: { key: "{{ inputs.caseId }}", policy: "cancel_existing" }, execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const first = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    // Manually advance `first` into "running" so it's genuinely non-terminal
    // when the second trigger arrives.
    await store.runs.put({ ...first, status: "running" });

    const second = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    expect(second.status).toBe("pending");

    const cancelledFirst = await store.runs.get(first.runId);
    expect(cancelledFirst?.status).toBe("cancelled");
    expect(cancelledFirst?.trace.some((t) => t.status === "skipped")).toBe(true);
  });

  it("reject_new: throws ConcurrencyRejectedError, no RunRecord created", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-reject", concurrency: { key: "{{ inputs.caseId }}", policy: "reject_new" } });
    const first = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    const countBefore = (await store.runs.list({ workflowId: "wf-reject" })).length;

    await expect(triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } })).rejects.toThrow(ConcurrencyRejectedError);

    const countAfter = (await store.runs.list({ workflowId: "wf-reject" })).length;
    expect(countAfter).toBe(countBefore);
    void first;
  });
});

describe("executeRun — fresh execution", () => {
  it("transitions pending -> running -> completed for a simple linear workflow", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("completed");
    expect(finished.trace.map((t) => t.stepId)).toEqual(["s1", "s2"]);
    expect(finished.endedAt).toBeTruthy();
  });

  it("resolves the workflow outputMapping into the completed RunRecord's public outputs", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "value", type: "string", required: true }],
      outputs: [{ name: "result", type: "object", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo", with: { value: "{{ inputs.value }}" } }],
        outputMapping: { result: "{{ steps.s1.outputs.echoed }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { value: "reusable" } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({ result: { value: "reusable" } });
    await expect(store.runs.get(run.runId)).resolves.toMatchObject({ outputs: { result: { value: "reusable" } } });
  });

  it("preserves backward-compatible custom output types as opaque Pack-defined contracts", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "publishedAt", type: "date", required: true }],
      outputs: [{ name: "publishedAt", type: "date", required: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }],
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }],
        outputMapping: { publishedAt: "{{ inputs.publishedAt }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { publishedAt: "2026-07-28" } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({ publishedAt: "2026-07-28" });
  });

  it("fails terminally when a declared workflow output cannot be resolved", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }],
        outputMapping: { result: "{{ steps.s1.outputs.missing }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/workflow output mapping failed/i);
  });

  it("omits an optional mapped output only when its valid source step was skipped", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "includeResult", type: "boolean", required: true }],
      outputs: [{ name: "optionalResult", type: "string" }],
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo", if: "{{ inputs.includeResult }}" }],
        outputMapping: { optionalResult: "{{ steps.s1.outputs.missing }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { includeResult: false } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({});
  });

  it("omits an optional interpolation when the unresolved token belongs to a skipped valid source", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "includeDetail", type: "boolean", required: true }],
      outputs: [{ name: "optionalResult", type: "string" }],
      execution: {
        type: "workflow",
        steps: [
          { id: "base", uses: "test.echo", with: { value: "prefix-" } },
          { id: "detail", uses: "test.echo", with: { value: "detail" }, if: "{{ inputs.includeDetail }}" },
        ],
        outputMapping: {
          optionalResult:
            "{{ steps.base.outputs.echoed.value }}{{ steps.detail.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { includeDetail: false },
    });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({});
  });

  it("fails a structurally malformed optional mapping even when its source step was skipped", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "includeResult", type: "boolean", required: true }],
      outputs: [{ name: "optionalResult", type: "string" }],
      execution: {
        type: "workflow",
        steps: [{ id: "optional", uses: "test.echo", if: "{{ inputs.includeResult }}" }],
        outputMapping: { optionalResult: "{{ steps.optional.outptus.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { includeResult: false } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/workflow output mapping failed/i);
  });

  it("rejects an unmatched output expression even when a canonical workflow bypasses authoring validation", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "read", uses: "test.echo" }],
        outputMapping: { result: "{{ steps.read.outputs.echoed" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/unmatched expression delimiter/i);
  });

  it("fails an optional mapping whose source step ran but did not produce the referenced field", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      outputs: [{ name: "optionalResult", type: "string" }],
      execution: {
        type: "workflow",
        steps: [{ id: "read", uses: "test.echo" }],
        outputMapping: { optionalResult: "{{ steps.read.outputs.typo }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/workflow output mapping failed/i);
  });

  it('stores "__proto__" as an own public output without changing the output map prototype', async () => {
    const { store, config } = await setup();
    const outputMapping = JSON.parse('{"__proto__":"{{ inputs.value }}"}') as Record<string, string>;
    const workflow = fixtureWorkflow({
      inputs: [{ name: "value", type: "string", required: true }],
      outputs: [{ name: "__proto__", type: "string", required: true }],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }], outputMapping },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { value: "safe-value" } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(Object.prototype.hasOwnProperty.call(finished.outputs, "__proto__")).toBe(true);
    expect(finished.outputs?.["__proto__"]).toBe("safe-value");
    expect(Object.getPrototypeOf(finished.outputs)).toBe(Object.prototype);
  });

  it.each([
    {
      contract: "type",
      field: { name: "result", type: "string", required: true },
      value: { nested: true },
      error: /expected type "string"/,
    },
    {
      contract: "enum",
      field: { name: "result", type: "string", required: true, enum: ["alpha", "beta"] },
      value: "gamma",
      error: /not one of its declared enum values/,
    },
    {
      contract: "pattern",
      field: { name: "result", type: "string", required: true, pattern: "^[A-Z]+$" },
      value: "lowercase",
      error: /does not match declared pattern/,
    },
  ] satisfies Array<{ contract: string; field: Field; value: unknown; error: RegExp }>)(
    "fails terminally when a mapped output violates its declared $contract contract",
    async ({ field, value, error }) => {
      const { store, config } = await setup();
      const workflow = fixtureWorkflow({
        inputs: [{ name: "value", type: "unknown", required: true }],
        outputs: [field],
        execution: {
          type: "workflow",
          steps: [{ id: "s1", uses: "test.echo" }],
          outputMapping: { result: "{{ inputs.value }}" },
        },
      });
      await store.workflows.put(workflow);
      const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { value } });
      const finished = await executeRun(config, run.runId);

      expect(finished.status).toBe("failed");
      expect(finished.outputs).toBeUndefined();
      expect(finished.error).toMatch(/workflow output validation failed/i);
      expect(finished.error).toMatch(error);
    },
  );

  it("fails terminally when a required output is absent even if a canonical workflow bypasses authoring validation", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/required output "result" is missing/i);
  });

  it("fails terminally when canonical output declarations contain duplicate names", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      inputs: [{ name: "value", type: "unknown", required: true }],
      outputs: [
        { name: "result", type: "string", required: true },
        { name: "result", type: "number", required: true },
      ],
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }],
        outputMapping: { result: "{{ inputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { value: 42 } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/output "result" is declared more than once/);
  });

  it("validates the redacted value that will be persisted, not only the raw mapped output", async () => {
    const { store, config } = await setup({
      resolveSecret: () => 42,
      redact: (record, refs) => redactResolvedValues(record, refs),
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "pin", type: "integer", required: true }],
      outputs: [{ name: "pin", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "resolve", uses: "test.echo", with: { secret: "{{ secrets.PIN }}" } }],
        outputMapping: { pin: "{{ inputs.pin }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { pin: 42 } });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/expected type "integer" but received "string"/);
  });

  it("rejects a public outputMapping that reads a secret directly", async () => {
    const { store, config } = await setup({ resolveSecret: () => "secret-value" });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "secret", type: "string" }],
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }],
        outputMapping: { secret: "{{ secrets.API_KEY }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/public outputMapping "secret" may not reference secrets/);
  });

  it("captures ExecutionSnapshot at completion for a run that never waits", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.snapshot.capturedAt).not.toBe("");
    expect(finished.snapshot.definitions).toMatchObject({ id: workflow.id });
  });

  it("calls onRunTerminal with the runId once the run reaches a terminal status (S9 reconciliation ledger item 10)", async () => {
    const calls: string[] = [];
    const { store, config } = await setup({ onRunTerminal: (runId) => void calls.push(runId) });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("completed");
    expect(calls).toEqual([run.runId]);
  });

  it("a throwing onRunTerminal never fails the run's own (already-persisted) terminal transition", async () => {
    const { store, config } = await setup({
      onRunTerminal: () => {
        throw new Error("simulated browser-cleanup failure");
      },
    });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("completed"); // the hook's throw did not propagate
  });

  it("transitions to failed when a step fails with no retry", async () => {
    const failing = failingBlock("test.rl-fail");
    const { store, config } = await setup({ blocks: { [failing.manifest.id]: failing } });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.rl-fail" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("failed");
    expect(finished.error).toBeTruthy();
  });

  it("enters waiting status for a workflow ending in a wait step, and captures the snapshot at that point", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "wait_step", uses: "wait.manual" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const waiting = await executeRun(config, run.runId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.snapshot.capturedAt).not.toBe("");
    expect(waiting.trace.find((t) => t.stepId === "wait_step")?.status).toBe("waiting");
  });

  it("throws for an unknown runId", async () => {
    const { config } = await setup();
    await expect(executeRun(config, "no-such-run")).rejects.toThrow(/no runrecord found/i);
  });

  it("is idempotent for an already-terminal run (a caller racing another resume mechanism doesn't corrupt state)", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    const second = await executeRun(config, run.runId);
    expect(second).toEqual(finished);
  });

  it("releases a queued run once the blocking run completes", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ id: "wf-release", concurrency: { key: "{{ inputs.caseId }}", policy: "queue" }, execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const first = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    const second = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: "case-1" } });
    expect((await store.jobQueue.listClaimable(new Date().toISOString())).map((c) => c.runId)).not.toContain(second.runId);

    await executeRun(config, first.runId); // completes -> should release `second`

    const claimableAfter = await store.jobQueue.listClaimable(new Date().toISOString());
    expect(claimableAfter.map((c) => c.runId)).toContain(second.runId);
    const reloadedSecond = await store.runs.get(second.runId);
    expect(reloadedSecond?.params?.waitingOnConcurrency).toBe(false);
  });

  it("releases a queued run with the original concurrency key even when redaction rewrites that key in the terminal record", async () => {
    const secret = "queue-secret";
    const { store, config } = await setup({
      resolveSecret: () => secret,
      redact: (record, refs) => redactResolvedValues(record, refs),
    });
    const workflow = fixtureWorkflow({
      id: "wf-secret-key-release",
      inputs: [{ name: "caseId", type: "string", required: true }],
      outputs: [{ name: "result", type: "string", required: true }],
      concurrency: { key: "{{ inputs.caseId }}", policy: "queue" },
      execution: {
        type: "workflow",
        steps: [{ id: "resolve", uses: "test.echo", with: { secret: "{{ secrets.PIN }}" } }],
        outputMapping: { result: "{{ inputs.caseId }}" },
      },
    });
    await store.workflows.put(workflow);
    const first = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: secret } });
    const second = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: { caseId: secret } });

    const finished = await executeRun(config, first.runId);

    expect(finished.params?.concurrencyKey).not.toContain(secret);
    expect((await store.jobQueue.listClaimable(new Date().toISOString())).map((job) => job.runId)).toContain(second.runId);
    await expect(store.runs.get(second.runId)).resolves.toMatchObject({ params: { waitingOnConcurrency: false } });
  });
});

describe("executeRun — reclaim-safety: resumes mid-step from persisted trace history, not just from a clean pending state", () => {
  it("a run already 'running' with a partially-completed trace continues from the correct next step (simulating a worker reclaim after a crash)", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }, { id: "s3", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    // Simulate: a worker claimed this run, completed s1, then crashed
    // before s2 — a DIFFERENT worker later reclaims it (architecture §4.7).
    // No in-memory state carries over; only what's in the store matters.
    await store.runs.put({
      ...run,
      status: "running",
      trace: [{ seq: 0, stepId: "s1", block: "test.echo", status: "completed", inputs: {}, outputs: { echoed: {} }, startedAt: "t", endedAt: "t" }],
    });

    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("completed");
    expect(finished.trace.map((t) => t.stepId)).toEqual(["s1", "s2", "s3"]); // s1 NOT re-executed
  });

  it("a trailing FAILED trace entry that never reached a terminal run status is retried, not treated as already-advanced-past", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    // Simulate a crash between "failed StepTrace recorded" and "run
    // finalized as failed" (run.status still "running").
    await store.runs.put({
      ...run,
      status: "running",
      trace: [{ seq: 0, stepId: "s1", block: "test.echo", status: "failed", inputs: {}, error: "prior crash", startedAt: "t", endedAt: "t" }],
    });

    const finished = await executeRun(config, run.runId);
    // Retried and succeeded this time (test.echo never fails) — status completed.
    expect(finished.status).toBe("completed");
    expect(finished.trace.filter((t) => t.stepId === "s1")).toHaveLength(2);
  });
});

describe("cancelRun (architecture §4.1, spec F16)", () => {
  it("sets status cancelled and records unreached steps as skipped", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }, { id: "s3", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    await store.runs.put({ ...run, status: "running", trace: [{ seq: 0, stepId: "s1", block: "test.echo", status: "completed", inputs: {}, outputs: {}, startedAt: "t", endedAt: "t" }] });

    const cancelled = await cancelRun(config, run.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.trace.find((t) => t.stepId === "s1")?.status).toBe("completed"); // already-reached step untouched
    expect(cancelled.trace.find((t) => t.stepId === "s2")?.status).toBe("skipped");
    expect(cancelled.trace.find((t) => t.stepId === "s3")?.status).toBe("skipped");
  });

  it("calls onRunTerminal with the runId once cancelled (S9 reconciliation ledger item 10 - cancelRun is a SEPARATE terminal-transition path from finalizeTerminal, needs the same hook)", async () => {
    const calls: string[] = [];
    const { store, config } = await setup({ onRunTerminal: (runId) => void calls.push(runId) });
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }, { id: "s2", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    await store.runs.put({ ...run, status: "running" });

    const cancelled = await cancelRun(config, run.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(calls).toEqual([run.runId]);
  });

  it("is idempotent for an already-terminal run", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({ execution: { type: "workflow", steps: [{ id: "s1", uses: "test.echo" }] } });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);
    expect(finished.status).toBe("completed");
    const result = await cancelRun(config, run.runId);
    expect(result).toEqual(finished); // unchanged — cancelling a completed run is a no-op
    void store;
  });

  it("throws for an unknown runId", async () => {
    const { config } = await setup();
    await expect(cancelRun(config, "no-such-run")).rejects.toThrow(/no runrecord found/i);
  });
});
