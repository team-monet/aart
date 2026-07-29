import type { AartStore } from "@aart/store";
import { ConcurrencyRejectedError } from "@aart/types";
import type { BlockImplementation, Field } from "@aart/types";
import { afterEach, describe, expect, it } from "vitest";
import { idempotencyStorageKey, recordIdempotency } from "./idempotency.js";
import {
  cancelRun,
  executeRun,
  finalizeTerminal,
  triggerRun,
} from "./run-lifecycle.js";
import {
  applyRunRedaction,
  repairGlobalAuditsForNewSecrets,
} from "./redaction.js";
import { createTestStore, echoBlock, failingBlock, fixtureRun, fixtureTrigger, testEngineConfig, fixtureWorkflow } from "./test-utils/fixtures.js";
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

  it("keeps a pending run executable when another run later classifies one of its inputs as secret", async () => {
    const secret = "queued-pending-secret";
    const requireExactInput: BlockImplementation = {
      manifest: {
        id: "test.require-pending-input",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description:
          "Proves pending execution receives its exact submitted input.",
      },
      execute: async (inputs) => ({
        accepted:
          (inputs as Record<string, unknown>)["token"] === secret,
      }),
    };
    const { store, config } = await setup({
      blocks: {
        [requireExactInput.manifest.id]: requireExactInput,
      },
      redact: redactResolvedValues,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "consume",
            uses: requireExactInput.manifest.id,
            with: { token: "{{ inputs.token }}" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: secret },
    });

    await repairGlobalAuditsForNewSecrets(
      store,
      redactResolvedValues,
      new Set([secret]),
    );

    expect(
      JSON.stringify(await store.runs.get(run.runId)),
    ).not.toContain(secret);
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toMatchObject({
      run: { status: "pending", inputs: { token: secret } },
      resolvedSecretValues: [secret],
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.trace[0]).toMatchObject({
      outputs: { accepted: true },
      secretTainted: true,
    });
    await expect(
      store.runs.getOperationalState(run.runId),
    ).resolves.toBeUndefined();
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
    expect(run.schemaVersion).toBe(2);
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

  it("fails instead of publishing a conservatively redacted output that violates its declared contract", async () => {
    const { config } = await setup({
      redact: redactResolvedValues,
    });
    const workflow = fixtureWorkflow({
      outputs: [
        {
          name: "result",
          type: "string",
          required: true,
          pattern: "^prefix-",
        },
      ],
      execution: {
        type: "workflow",
        steps: [{ id: "produce", uses: "test.echo" }],
        outputMapping: {
          result: "{{ steps.produce.outputs.value }}",
        },
      },
    });
    const run = fixtureRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "produce",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "prefix-secret-suffix" },
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });

    const finished = await finalizeTerminal(
      config,
      run,
      workflow,
      "completed",
      new Set(["secret"]),
    );

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/pattern/);
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

  it("fails before a later wait can persist and normalize a non-JSON step output", async () => {
    const nonJsonBlock: BlockImplementation = {
      manifest: {
        id: "test.non-json",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a Date for persistence-boundary testing.",
      },
      execute: async () => ({ value: new Date("2026-07-28T00:00:00.000Z") }),
    };
    const { store, config } = await setup({
      blocks: { [nonJsonBlock.manifest.id]: nonJsonBlock },
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "produce", uses: nonJsonBlock.manifest.id },
          { id: "pause", uses: "wait.time", with: { duration: "1m" } },
        ],
        outputMapping: { result: "{{ steps.produce.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/plain JSON objects/);
    const persisted = await store.runs.get(run.runId);
    expect(persisted?.status).toBe("failed");
    expect(persisted).not.toHaveProperty("outputs");
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

  it("rejects an optional output whose absent source reveals a secret-controlled branch", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "optionalResult", type: "string" }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ secrets.FLAG }}",
            then: "selected",
            else: "optional",
          },
          {
            id: "optional",
            uses: "test.echo",
            with: { value: "optional" },
          },
          {
            id: "selected",
            uses: "test.echo",
            with: { value: "selected" },
          },
        ],
        outputMapping: {
          optionalResult: "{{ steps.optional.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(
      /absent step "optional" after secret-controlled flow/,
    );
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
    expect(finished.error).toMatch(
      /public outputMapping "pin" depends on secret-tainted inputs path "\/pin"/,
    );
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

  it("rejects a public output indirectly sourced from a secret before trace redaction can turn it into a marker", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "secret", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "echo", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } }],
        outputMapping: { secret: "{{ steps.echo.outputs.echoed.secret }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/secret-tainted|changed by secret redaction/);
    expect(JSON.stringify(await store.runs.get(run.runId))).not.toContain("secret-value");
  });

  it("allows a public step status mapping when only the step output data is secret-tainted", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "status", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "echo",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { status: "{{ steps.echo.status }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({ status: "completed" });
    expect(finished.trace[0]).toMatchObject({
      status: "completed",
      secretTainted: true,
    });
  });

  it("does not taint a later step that consumes only secret-producing step status metadata", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "status", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "source",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
          {
            id: "consume_status",
            uses: "test.echo",
            with: { value: "{{ steps.source.status }}" },
          },
        ],
        outputMapping: {
          status:
            "{{ steps.consume_status.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({ status: "completed" });
    expect(
      finished.trace.find(
        (trace) => trace.stepId === "consume_status",
      )?.secretTainted,
    ).toBeUndefined();
  });

  it("rejects a non-literal derivative of a directly referenced secret", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.direct-secret-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns only the length of its input.",
      },
      execute: async (inputs) => ({
        length: String((inputs as Record<string, unknown>)["source"]).length,
      }),
    };
    const { store, config } = await setup({
      blocks: { [deriveLength.manifest.id]: deriveLength },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: deriveLength.manifest.id,
            with: { source: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { result: "{{ steps.derive.outputs.length }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "derive"/);
    expect(finished.trace[0]).toMatchObject({ secretTainted: true });
  });

  it("rejects a non-literal derivative when a block resolves the data secret internally", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.internal-secret-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Resolves secret data and returns only its length.",
      },
      execute: async (_inputs, ctx) => ({
        length: (await ctx.resolveSecret("API_KEY")).length,
      }),
    };
    const { store, config } = await setup({
      blocks: { [deriveLength.manifest.id]: deriveLength },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "derive", uses: deriveLength.manifest.id }],
        outputMapping: { result: "{{ steps.derive.outputs.length }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(
      /secret-tainted step "derive" output path "\/length"/,
    );
    expect(finished.trace[0]).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
  });

  it("allows a trusted block to use a credential without tainting its public response", async () => {
    const authenticatedLookup: BlockImplementation = {
      manifest: {
        id: "test.credential-lookup",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Uses a credential only at its authentication boundary.",
      },
      execute: async (_inputs, ctx) => {
        await ctx.resolveSecret("API_KEY", { usage: "credential" });
        return { accountName: "Acme" };
      },
    };
    const { store, config } = await setup({
      blocks: { [authenticatedLookup.manifest.id]: authenticatedLookup },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
      canUseCredentialSecrets: ({ block }) =>
        block === authenticatedLookup,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "accountName", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [{ id: "lookup", uses: authenticatedLookup.manifest.id }],
        outputMapping: {
          accountName: "{{ steps.lookup.outputs.accountName }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({ accountName: "Acme" });
    expect(finished.trace[0]?.secretTainted).toBeUndefined();
  });

  it("does not let an untrusted block self-classify derived secret data as credential-only", async () => {
    const untrustedLookup: BlockImplementation = {
      manifest: {
        id: "pack.untrusted-credential",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Attempts to downgrade secret-derived output.",
      },
      execute: async (_inputs, ctx) => {
        const secret = await ctx.resolveSecret("API_KEY", {
          usage: "credential",
        });
        return { secretLength: secret.length };
      },
    };
    const { store, config } = await setup({
      blocks: { [untrustedLookup.manifest.id]: untrustedLookup },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "secretLength", type: "number", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "lookup",
            uses: untrustedLookup.manifest.id,
            idempotencyKey: "untrusted-credential",
          },
        ],
        outputMapping: {
          secretLength: "{{ steps.lookup.outputs.secretLength }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "lookup"/);
    expect(finished.trace[0]).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("untrusted-credential"),
      ),
    ).resolves.toBeUndefined();
  });

  it("propagates a secret-consuming forEach child's provenance to the aggregate output", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.foreach-secret-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Resolves secret data per item and returns its length.",
      },
      execute: async (_inputs, ctx) => ({
        length: (await ctx.resolveSecret("API_KEY")).length,
      }),
    };
    const { store, config } = await setup({
      blocks: { [deriveLength.manifest.id]: deriveLength },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "items", type: "array", required: true }],
      outputs: [{ name: "results", type: "array", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: deriveLength.manifest.id,
            forEach: "{{ inputs.items }}",
          },
        ],
        outputMapping: { results: "{{ steps.derive.outputs.items }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { items: ["one"] },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(
      /secret-tainted step "derive" output path "\/items"/,
    );
    expect(finished.trace.find((trace) => trace.stepId === "derive")).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["/items/0"],
    });
  });

  it("propagates a later-discovered input secret through a downstream transform", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.input-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns the length of its input.",
      },
      execute: async (inputs) => ({
        length: String(
          (inputs as Record<string, unknown>)["source"],
        ).length,
      }),
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [deriveLength.manifest.id]: deriveLength,
      },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
          {
            id: "derive",
            uses: deriveLength.manifest.id,
            with: { source: "{{ inputs.token }}" },
          },
        ],
        outputMapping: { result: "{{ steps.derive.outputs.length }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-value" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.trace.find((trace) => trace.stepId === "derive")).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
  });

  it("retroactively taints an earlier transform and revokes its cache when the matching secret is discovered later", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.early-input-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns the length of its input.",
      },
      execute: async (inputs) => {
        const source = String(
          (inputs as Record<string, unknown>)["source"],
        );
        return { value: source, length: source.length };
      },
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [deriveLength.manifest.id]: deriveLength,
      },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: deriveLength.manifest.id,
            with: { source: "{{ inputs.token }}" },
            idempotencyKey: "derive-once",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { result: "{{ steps.derive.outputs.length }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-value" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.trace.find((trace) => trace.stepId === "derive")).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("derive-once"),
      ),
    ).resolves.toBeUndefined();
  });

  it("revokes a global cache entry replayed from another run when this run later discovers its output is secret", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    await recordIdempotency(
      store,
      "shared-result",
      "originating-run",
      "cached",
      { value: "secret-value" },
      new Date(),
    );
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: "test.echo",
            idempotencyKey: "shared-result",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { result: "{{ steps.cached.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.trace.find((trace) => trace.stepId === "cached")).toMatchObject({
      secretTainted: true,
    });
    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("shared-result")),
    ).resolves.toBeUndefined();
  });

  it("revokes a cache entry whose key is later discovered to contain a secret even when its output is clean", async () => {
    const constantBlock: BlockImplementation = {
      manifest: {
        id: "test.clean-constant",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a public constant.",
      },
      execute: async () => ({ value: "public" }),
    };
    const { store, config } = await setup({
      blocks: { [constantBlock.manifest.id]: constantBlock },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-key",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: constantBlock.manifest.id,
            idempotencyKey: "{{ inputs.token }}",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-key" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.trace.find((trace) => trace.stepId === "cached")).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("secret-key")),
    ).resolves.toBeUndefined();
    expect(JSON.stringify(finished)).not.toContain("v2:secret-key");
  });

  it("revokes earlier cache entries when later secret resolution is followed by a thrown engine refusal", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: "test.echo",
            with: { value: "{{ inputs.token }}" },
            idempotencyKey: "cached-before-refusal",
          },
          {
            id: "refused",
            uses: "test.missing-block",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-value" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/No BlockImplementation/);
    await expect(
      store.idempotencyLedger.get(
        idempotencyStorageKey("cached-before-refusal"),
      ),
    ).resolves.toBeUndefined();
  });

  it("rolls back cache revocation when the same transaction cannot persist the redacted run", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "cached",
            uses: "test.echo",
            with: { value: "{{ inputs.token }}" },
            idempotencyKey: "atomic-revocation",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-value" },
    });
    const originalTransact = store.transact.bind(store);
    store.transact = (fn) => originalTransact(async (tx) => {
      const originalPutRun = tx.runs.put.bind(tx.runs);
      tx.runs.put = async (record) => {
        await originalPutRun(record);
        if (record.trace.some((trace) => trace.stepId === "discover")) {
          throw new Error("simulated run persistence failure");
        }
      };
      return fn(tx);
    });

    await expect(executeRun(config, run.runId)).rejects.toThrow(
      /simulated run persistence failure/,
    );

    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("atomic-revocation")),
    ).resolves.toBeDefined();
    const persisted = await store.runs.get(run.runId);
    expect(persisted?.trace.some((trace) => trace.stepId === "discover")).toBe(
      false,
    );
    expect(JSON.stringify(persisted)).toContain("secret-value");
  });

  it("retroactively taints a completed forEach whose source later becomes secret", async () => {
    const constantBlock: BlockImplementation = {
      manifest: {
        id: "test.for-each-constant",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a constant for every item.",
      },
      execute: async () => ({ value: "included" }),
    };
    const { store, config } = await setup({
      blocks: { [constantBlock.manifest.id]: constantBlock },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-item",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "tokens", type: "json", required: true }],
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "map",
            uses: constantBlock.manifest.id,
            forEach: "{{ inputs.tokens }}",
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { result: "{{ steps.map.outputs.items }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { tokens: ["secret-item"] },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(
      finished.trace.find(
        (trace) => trace.stepId === "map" && trace.iterationIndex === undefined,
      ),
    ).toMatchObject({
      secretTainted: true,
      secretTaintedPaths: ["*"],
    });
  });

  it("does not admit a secret-control-selected successor into the global cache", async () => {
    const constantBlock: BlockImplementation = {
      manifest: {
        id: "test.control-selected-constant",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a public branch label.",
      },
      execute: async () => ({ value: "selected" }),
    };
    const { store, config } = await setup({
      blocks: { [constantBlock.manifest.id]: constantBlock },
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ secrets.FLAG }}",
          },
          {
            id: "selected",
            uses: constantBlock.manifest.id,
            idempotencyKey: "selected-result",
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    await executeRun(config, run.runId);

    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("selected-result")),
    ).resolves.toBeUndefined();
  });

  it("retroactively propagates a later-discovered secret through an earlier control decision", async () => {
    const constantBlock: BlockImplementation = {
      manifest: {
        id: "test.constant-allowed",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a public branch label.",
      },
      execute: async () => ({ decision: "allowed" }),
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [constantBlock.manifest.id]: constantBlock,
      },
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "flag", type: "boolean", required: true }],
      outputs: [{ name: "decision", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ inputs.flag }}",
          },
          {
            id: "selected",
            uses: constantBlock.manifest.id,
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.FLAG }}" },
          },
        ],
        outputMapping: {
          decision: "{{ steps.selected.outputs.decision }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { flag: true },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(
      finished.trace.find((trace) => trace.stepId === "selected"),
    ).toMatchObject({
      controlSecretTainted: true,
    });
    expect(finished.error).toMatch(
      /secret-tainted step "selected".*secret-controlled/,
    );
  });

  it("retroactively propagates control taint through an earlier transformed trace", async () => {
    const deriveFlag: BlockImplementation = {
      manifest: {
        id: "test.early-derived-flag",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Derives a boolean from its input.",
      },
      execute: async (inputs) => ({
        positive:
          String(
            (inputs as Record<string, unknown>)["source"],
          ).length > 0,
      }),
    };
    const constantBlock: BlockImplementation = {
      manifest: {
        id: "test.indirect-constant-allowed",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a public branch label.",
      },
      execute: async () => ({ decision: "allowed" }),
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [deriveFlag.manifest.id]: deriveFlag,
        [constantBlock.manifest.id]: constantBlock,
      },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "token", type: "string", required: true }],
      outputs: [{ name: "decision", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "derive",
            uses: deriveFlag.manifest.id,
            with: { source: "{{ inputs.token }}" },
          },
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ steps.derive.outputs.positive }}",
          },
          {
            id: "selected",
            uses: constantBlock.manifest.id,
          },
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: {
          decision: "{{ steps.selected.outputs.decision }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { token: "secret-value" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(
      finished.trace.find((trace) => trace.stepId === "derive"),
    ).toMatchObject({ secretTaintedPaths: ["*"] });
    expect(
      finished.trace.find((trace) => trace.stepId === "selected"),
    ).toMatchObject({ controlSecretTainted: true });
  });

  it("rejects a public trigger mapping whose value is later discovered as secret", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "token", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "discover",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
        ],
        outputMapping: { token: "{{ trigger.payload.token }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger({
        payload: { token: "secret-value" },
      }),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(
      /secret-tainted trigger path "\/payload\/token"/,
    );
  });

  it("preserves secret taint across an intermediate persisted step", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "source", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } },
          {
            id: "relay",
            uses: "test.echo",
            with: { value: "{{ steps.source.outputs.echoed.secret }}" },
          },
        ],
        outputMapping: { result: "{{ steps.relay.outputs.echoed.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.outputs).toBeUndefined();
    expect(finished.error).toMatch(/secret-tainted step "relay"/);
    expect(finished.trace.find((trace) => trace.stepId === "source")).toMatchObject({
      secretTainted: true,
    });
    expect(JSON.stringify(await store.runs.get(run.runId))).not.toContain("secret-value");
  });

  it("treats a whole-steps expression as depending on every tainted trace", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "source", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } },
          { id: "relay", uses: "test.echo", with: { allSteps: "{{ steps }}" } },
        ],
        outputMapping: { result: "{{ steps.relay.outputs.echoed.allSteps }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "relay"/);
    expect(JSON.stringify(await store.runs.get(run.runId))).not.toContain("secret-value");
  });

  it("taints an older trace when a later step newly resolves the matching secret", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "earlier", uses: "test.echo", with: { value: "secret-value" } },
          { id: "discover", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } },
        ],
        outputMapping: { result: "{{ steps.earlier.outputs.echoed.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "earlier"/);
    expect(JSON.stringify(await store.runs.get(run.runId))).not.toContain("secret-value");
  });

  it("recomputes current-step inheritance after that step discovers a matching secret", async () => {
    const deriveLength: BlockImplementation = {
      manifest: {
        id: "test.derive-length",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns a non-literal derivative of an input.",
      },
      execute: async (inputs) => ({
        length: String((inputs as Record<string, unknown>)["source"]).length,
      }),
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [deriveLength.manifest.id]: deriveLength,
      },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "integer", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "earlier", uses: "test.echo", with: { value: "secret-value" } },
          {
            id: "derive",
            uses: deriveLength.manifest.id,
            with: {
              source: "{{ steps.earlier.outputs.echoed.value }}",
              discover: "{{ secrets.API_KEY }}",
            },
          },
        ],
        outputMapping: { result: "{{ steps.derive.outputs.length }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "derive"/);
  });

  it("does not treat a later clean-looking poll as safe when the block previously used a data secret", async () => {
    let attempts = 0;
    const pollingBlock: BlockImplementation = {
      manifest: {
        id: "test.poll-secret-then-clean",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns one tainted intermediate value, then a clean final value.",
      },
      execute: async (_inputs, ctx) => {
        attempts += 1;
        return attempts === 1
          ? { done: false, value: await ctx.resolveSecret("API_KEY") }
          : { done: true, value: "clean-result" };
      },
    };
    const { store, config } = await setup({
      blocks: {
        [echoBlock.manifest.id]: echoBlock,
        [pollingBlock.manifest.id]: pollingBlock,
      },
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "poll",
            uses: pollingBlock.manifest.id,
            next: "poll",
            maxIterations: 2,
            until: "{{ steps.poll.outputs.done }}",
          },
          { id: "relay", uses: "test.echo", with: { allSteps: "{{ steps }}" } },
        ],
        outputMapping: {
          result:
            "{{ steps.relay.outputs.echoed.allSteps.poll.outputs.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "relay"/);
    expect(finished.trace.filter((trace) => trace.stepId === "poll")).toMatchObject([
      { secretTainted: true },
      { outputs: { value: "clean-result" }, controlSecretTainted: true },
    ]);
    expect(finished.trace.find((trace) => trace.stepId === "relay")).toMatchObject({
      controlSecretTainted: true,
    });
  });

  it("refreshes trace taint when until is the first expression to resolve a secret", async () => {
    const booleanOutput: BlockImplementation = {
      manifest: {
        id: "test.boolean-output",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Returns the same boolean later resolved as a secret.",
      },
      execute: async () => ({ value: true }),
    };
    const { store, config } = await setup({
      blocks: { [booleanOutput.manifest.id]: booleanOutput },
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "poll",
            uses: booleanOutput.manifest.id,
            next: "poll",
            maxIterations: 1,
            until: "{{ secrets.STOP }}",
          },
        ],
        outputMapping: { result: "{{ steps.poll.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, { workflow, trigger: fixtureTrigger(), inputs: {} });
    const persistedPollValues: unknown[] = [];
    const originalTransact = store.transact.bind(store);
    store.transact = (fn) => originalTransact(async (tx) => {
      const originalPutRun = tx.runs.put.bind(tx.runs);
      tx.runs.put = async (record) => {
        const poll = record.trace.find((trace) => trace.stepId === "poll");
        if (poll?.outputs) persistedPollValues.push(poll.outputs["value"]);
        return originalPutRun(record);
      };
      return fn(tx);
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "poll"/);
    expect(finished.trace.find((trace) => trace.stepId === "poll")).toMatchObject({
      secretTainted: true,
    });
    expect(persistedPollValues).not.toContain(true);
    expect(persistedPollValues[0]).toMatch(/REDACTED/);
  });

  it("preserves a successful effect trace when post-dispatch until evaluation fails", async () => {
    let executeCount = 0;
    const effectBlock: BlockImplementation = {
      manifest: {
        id: "test.effect-before-control-failure",
        version: "1.0.0",
        capabilities: ["network"],
        inputSchema: {},
        outputSchema: {},
        description: "Represents an external effect that must not be hidden.",
      },
      execute: async () => ({ receipt: `effect-${++executeCount}` }),
    };
    const { store, config } = await setup({
      blocks: { [effectBlock.manifest.id]: effectBlock },
      getGrantedCapabilities: async () => ["network"],
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "effect",
            uses: effectBlock.manifest.id,
            idempotencyKey: "effect-once",
            next: "effect",
            until: "{{ steps.effect.outputs.missing }}",
            maxIterations: 2,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(executeCount).toBe(1);
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/resolved to undefined/);
    expect(finished.trace).toHaveLength(1);
    expect(finished.trace[0]).toMatchObject({
      stepId: "effect",
      status: "completed",
      outputs: { receipt: "effect-1" },
      idempotencyLedgerKey: idempotencyStorageKey("effect-once"),
    });
    await expect(
      store.idempotencyLedger.get(idempotencyStorageKey("effect-once")),
    ).resolves.toMatchObject({
      recordedOutput: { receipt: "effect-1" },
    });
  });

  it("re-redacts a text artifact when post-dispatch control first discovers its secret", async () => {
    let artifactId: string | undefined;
    const artifactBlock: BlockImplementation = {
      manifest: {
        id: "test.artifact-before-secret-discovery",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description: "Writes text before a later control expression resolves.",
      },
      execute: async (inputs, ctx) => {
        const value = (inputs as { value: string }).value;
        artifactId = (
          await ctx.writeArtifact({
            name: "result.txt",
            kind: "report",
            mime: "text/plain",
            bytes: new TextEncoder().encode(value),
          })
        ).id;
        return { written: true };
      },
    };
    const { store, config } = await setup({
      blocks: { [artifactBlock.manifest.id]: artifactBlock },
      redact: redactResolvedValues,
      resolveSecret: () => "late-secret",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "value", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "write",
            uses: artifactBlock.manifest.id,
            with: { value: "{{ inputs.value }}" },
            next: "write",
            until: "{{ secrets.STOP }}",
            maxIterations: 1,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { value: "late-secret" },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(artifactId).toBeDefined();
    const bytes = await store.artifacts.getBytes(artifactId!);
    if (bytes === undefined) throw new Error("artifact bytes missing");
    expect(new TextDecoder().decode(bytes)).toBe("[REDACTED]");
    const metadata = await store.artifacts.getMetadata(artifactId!);
    expect(metadata?.bytes).toBe(bytes?.byteLength);
    expect(finished.artifacts).toContainEqual(metadata);
  });

  it("keeps original text eligibility when a known secret redacts the public MIME before a later secret is discovered", async () => {
    let artifactId: string | undefined;
    const artifactBlock: BlockImplementation = {
      manifest: {
        id: "test.redacted-text-mime",
        version: "1.0.0",
        capabilities: [],
        inputSchema: {},
        outputSchema: {},
        description:
          "Redacts MIME first, then discovers a second secret in text bytes.",
      },
      execute: async (_inputs, ctx) => {
        const mimePrefix = await ctx.resolveSecret("MIME_PREFIX");
        artifactId = (
          await ctx.writeArtifact({
            name: "result.txt",
            kind: "report",
            mime: `${mimePrefix}/plain`,
            bytes: new TextEncoder().encode("future-secret"),
          })
        ).id;
        await ctx.resolveSecret("LATE_VALUE");
        return { written: true };
      },
    };
    const { store, config } = await setup({
      blocks: { [artifactBlock.manifest.id]: artifactBlock },
      redact: redactResolvedValues,
      resolveSecret: (ref) =>
        ref === "MIME_PREFIX" ? "text" : "future-secret",
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "write",
            uses: artifactBlock.manifest.id,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(artifactId).toBeDefined();
    await expect(
      store.artifacts.isTextEligible(artifactId!),
    ).resolves.toBe(true);
    const bytes = await store.artifacts.getBytes(artifactId!);
    expect(
      bytes === undefined
        ? undefined
        : new TextDecoder().decode(bytes),
    ).toBe("[REDACTED]");
    await expect(
      store.artifacts.getMetadata(artifactId!),
    ).resolves.toMatchObject({
      mime: "[REDACTED]",
    });
  });

  it("taints an early-arrival wait after until first resolves a matching secret", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.for_signal",
            with: { name: "ready", correlationId: "early" },
            next: "pause",
            maxIterations: 1,
            until: "{{ secrets.STOP }}",
          },
        ],
        outputMapping: { result: "{{ steps.pause.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    await store.signals.append({
      id: "early-secret-signal",
      name: "ready",
      correlationId: "early",
      payload: { value: true },
      receivedAt: new Date().toISOString(),
    });
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "pause"/);
    expect(finished.trace.find((trace) => trace.stepId === "pause")).toMatchObject({
      secretTainted: true,
    });
    await expect(store.signals.list()).resolves.toContainEqual({
      id: "early-secret-signal",
      name: "ready",
      correlationId: "early",
      payload: { value: "[REDACTED]" },
      receivedAt: expect.any(String),
    });
  });

  it("keeps an early-arrival event completed when its post-event until cannot resolve", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "pause",
            uses: "wait.for_signal",
            with: { name: "ready", correlationId: "early-failure" },
            next: "pause",
            maxIterations: 2,
            until: "{{ steps.pause.outputs.missing }}",
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    await store.signals.append({
      id: "early-control-failure",
      name: "ready",
      correlationId: "early-failure",
      payload: { received: true },
      receivedAt: new Date().toISOString(),
    });
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/resolved to undefined/);
    expect(finished.trace).toEqual([
      expect.objectContaining({
        stepId: "pause",
        status: "completed",
        outputs: { received: true },
      }),
    ]);
    await expect(
      store.signals.findUnconsumedMatch("ready", "early-failure"),
    ).resolves.toBeUndefined();
  });

  it("taints the current step when until reads an already-known tainted trace", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "source",
            uses: "test.echo",
            with: { secret: "{{ secrets.API_KEY }}" },
          },
          {
            id: "poll",
            uses: "test.echo",
            with: { value: "clean-result" },
            next: "poll",
            maxIterations: 1,
            until: "{{ steps.source.outputs.echoed.secret }}",
          },
        ],
        outputMapping: { result: "{{ steps.poll.outputs.echoed.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "poll"/);
    expect(finished.trace.find((trace) => trace.stepId === "poll")).toMatchObject({
      secretTainted: true,
    });
  });

  it("carries secret-controlled branch taint into the selected successor", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => false,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ secrets.FLAG }}",
            then: "allowed",
            else: "denied",
          },
          { id: "allowed", uses: "test.echo", with: { value: "allowed" } },
          { id: "denied", uses: "test.echo", with: { value: "denied" } },
        ],
        outputMapping: {
          result: "{{ steps.denied.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "denied"/);
    expect(finished.trace.find((trace) => trace.stepId === "gate")).toMatchObject({
      secretTainted: true,
    });
    expect(finished.trace.find((trace) => trace.stepId === "denied")).toMatchObject({
      secretTainted: true,
    });
  });

  it("preserves an authored bracket-suffixed step id when propagating branch provenance", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => false,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate[0]",
            uses: "test.echo",
            if: "{{ secrets.FLAG }}",
            then: "allowed",
            else: "denied",
          },
          { id: "allowed", uses: "test.echo", with: { value: "allowed" } },
          { id: "denied", uses: "test.echo", with: { value: "denied" } },
        ],
        outputMapping: {
          result: "{{ steps.denied.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.trace.find((trace) => trace.stepId === "gate[0]")).toMatchObject({
      authoredStepId: "gate[0]",
      controlSecretTainted: true,
    });
    expect(finished.trace.find((trace) => trace.stepId === "denied")).toMatchObject({
      controlSecretTainted: true,
    });
  });

  it("propagates an indirect secret-controlled branch into its selected successor", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => false,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "string", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "source",
            uses: "test.echo",
            with: { flag: "{{ secrets.FLAG }}" },
          },
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ steps.source.outputs.echoed.flag }}",
            then: "allowed",
            else: "denied",
          },
          { id: "allowed", uses: "test.echo", with: { value: "allowed" } },
          { id: "denied", uses: "test.echo", with: { value: "denied" } },
        ],
        outputMapping: {
          result: "{{ steps.denied.outputs.echoed.value }}",
        },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.trace.find((trace) => trace.stepId === "gate")).toMatchObject({
      controlSecretTainted: true,
    });
    expect(finished.trace.find((trace) => trace.stepId === "denied")).toMatchObject({
      controlSecretTainted: true,
    });
  });

  it("respects a forEach binding that shadows a tainted real step id", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => "secret-value",
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "items", type: "array", required: true }],
      outputs: [{ name: "result", type: "array", required: true }],
      execution: {
        type: "workflow",
        steps: [
          { id: "item", uses: "test.echo", with: { secret: "{{ secrets.API_KEY }}" } },
          {
            id: "map",
            uses: "test.echo",
            forEach: "{{ inputs.items }}",
            as: "item",
            with: { value: "{{ steps.item }}" },
          },
        ],
        outputMapping: { result: "{{ steps.map.outputs.items }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { items: ["alpha"] },
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.outputs).toEqual({
      result: [{ echoed: { value: "alpha" } }],
    });
    expect(finished.trace.find((trace) => trace.stepId === "map")?.secretTainted).toBeUndefined();
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

  it("treats public terminal status as authoritative over stale protected running state", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [{ id: "s1", uses: "test.echo" }],
      },
    });
    await store.workflows.put(workflow);
    const triggered = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const finished = await executeRun(config, triggered.runId);
    await store.runs.putOperationalState(triggered.runId, {
      run: {
        ...triggered,
        status: "running",
      },
      resolvedSecretValues: [],
    });

    const reclaimed = await executeRun(config, triggered.runId);

    expect(reclaimed).toEqual(finished);
    await expect(
      store.runs.getOperationalState(triggered.runId),
    ).resolves.toBeUndefined();
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
    await expect(
      store.runs.getOperationalState(second.runId),
    ).resolves.toMatchObject({
      run: { params: { waitingOnConcurrency: false } },
    });
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

  it("refreshes taint when reclaim re-evaluates until after a completed trace was persisted", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      outputs: [{ name: "result", type: "json", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "poll",
            uses: "test.echo",
            next: "poll",
            maxIterations: 1,
            until: "{{ secrets.STOP }}",
          },
        ],
        outputMapping: { result: "{{ steps.poll.outputs.value }}" },
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await store.runs.put({
      ...run,
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "poll",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "public" },
          startedAt: "t",
          endedAt: "t",
        },
      ],
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/secret-tainted step "poll"/);
    expect(finished.trace[0]).toMatchObject({ secretTainted: true });
  });

  it("finalizes a reclaimed run without replacing its successful trace when control reconstruction fails", async () => {
    const { store, config } = await setup();
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          {
            id: "effect",
            uses: "test.echo",
            next: "effect",
            until: "{{ steps.effect.outputs.missing }}",
            maxIterations: 2,
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await store.runs.put({
      ...run,
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "effect",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { receipt: "already-happened" },
          startedAt: "t",
          endedAt: "t",
        },
      ],
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/resolved to undefined/);
    expect(finished.trace).toEqual([
      expect.objectContaining({
        stepId: "effect",
        status: "completed",
        outputs: { receipt: "already-happened" },
      }),
    ]);
  });

  it("reclaims a persisted skipped step through the same next path without evaluating until", async () => {
    let secretResolutions = 0;
    const { store, config } = await setup({
      resolveSecret: () => {
        secretResolutions += 1;
        return true;
      },
    });
    const workflow = fixtureWorkflow({
      inputs: [{ name: "runGate", type: "boolean", required: true }],
      execution: {
        type: "workflow",
        steps: [
          {
            id: "gate",
            uses: "test.echo",
            if: "{{ inputs.runGate }}",
            next: "expected",
            until: "{{ secrets.STOP }}",
          },
          {
            id: "wrong",
            uses: "test.echo",
            with: { path: "wrong" },
          },
          {
            id: "expected",
            uses: "test.echo",
            with: { path: "expected" },
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: { runGate: false },
    });
    await store.runs.put({
      ...run,
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "gate",
          authoredStepId: "gate",
          block: "test.echo",
          status: "skipped",
          inputs: {},
          startedAt: "t",
          endedAt: "t",
          durationMs: 0,
        },
      ],
    });

    const finished = await executeRun(config, run.runId);

    expect(secretResolutions).toBe(0);
    expect(finished.status).toBe("completed");
    expect(finished.trace.map((trace) => trace.stepId)).toEqual([
      "gate",
      "expected",
    ]);
  });

  it("does not treat a normal bracket-suffixed step as a forEach occurrence during reclaim", async () => {
    const { store, config } = await setup({
      redact: redactResolvedValues,
      resolveSecret: () => true,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "poll[0]", uses: "test.echo" },
          {
            id: "poll",
            uses: "test.echo",
            next: "poll",
            maxIterations: 1,
            until: "{{ secrets.STOP }}",
          },
        ],
      },
    });
    await store.workflows.put(workflow);
    const run = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    await store.runs.put({
      ...run,
      status: "running",
      trace: [
        {
          seq: 0,
          stepId: "poll[0]",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "safe" },
          startedAt: "t",
          endedAt: "t",
        },
        {
          seq: 1,
          stepId: "poll",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "public" },
          startedAt: "t",
          endedAt: "t",
        },
      ],
    });

    const finished = await executeRun(config, run.runId);

    expect(finished.status).toBe("completed");
    expect(finished.trace[0]?.secretTainted).toBeUndefined();
    expect(finished.trace[1]).toMatchObject({ secretTainted: true });
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

  it("deletes the outstanding protected wait atomically and keeps cancellation redacted", async () => {
    const secret = "cancelled-secret";
    const { store, config } = await setup({
      redact: redactResolvedValues,
    });
    const workflow = fixtureWorkflow({
      execution: {
        type: "workflow",
        steps: [
          { id: "pause", uses: "wait.manual" },
          { id: "after", uses: "test.echo" },
        ],
      },
    });
    await store.workflows.put(workflow);
    const created = await triggerRun(config, {
      workflow,
      trigger: fixtureTrigger(),
      inputs: {},
    });
    const rawWaiting = {
      ...created,
      status: "waiting" as const,
      inputs: { token: secret },
      waits: [
        {
          type: "manual" as const,
          schemaVersion: created.schemaVersion,
        },
      ],
      trace: [
        {
          seq: 0,
          stepId: "pause",
          block: "wait.manual",
          status: "waiting" as const,
          inputs: { token: secret },
          startedAt: new Date().toISOString(),
        },
      ],
      snapshot: {
        definitions: workflow,
        resolvedVersions: {},
        packHashes: {},
        capturedAt: new Date().toISOString(),
      },
    };
    await store.runs.put(
      applyRunRedaction(
        redactResolvedValues,
        rawWaiting,
        new Set([secret]),
      ),
    );
    await store.waits.put(
      created.runId,
      "pause",
      rawWaiting.waits[0]!,
      new Date().toISOString(),
      {
        run: rawWaiting,
        resolvedSecretValues: [secret],
      },
    );

    const cancelled = await cancelRun(config, created.runId);

    expect(cancelled.status).toBe("cancelled");
    expect(JSON.stringify(cancelled)).not.toContain(secret);
    await expect(
      store.waits.get(created.runId, "pause"),
    ).resolves.toBeUndefined();
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
