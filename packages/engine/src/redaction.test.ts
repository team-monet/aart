import {
  RunRecordSchema,
  SecretResolutionError,
  WaitConditionSchema,
  type WaitCondition,
  type StepTrace,
} from "@aart/types";
import { describe, expect, it } from "vitest";
import { applyRedaction, applyRunRedaction, createTrackingSecretResolver, identityRedactFn, mergePersistedRunTaint, redactWaitAudit, repairGlobalAuditsForNewSecrets, throwingSecretResolver } from "./redaction.js";
import { createTestStore, fixtureRun } from "./test-utils/fixtures.js";

describe("identityRedactFn", () => {
  it("returns the record unchanged — this session's own tests wire this by default (architecture §7.9)", () => {
    const record = { a: 1, secret: "shh" };
    expect(identityRedactFn(record, new Set(["shh"]))).toBe(record);
  });
});

describe("repairGlobalAuditsForNewSecrets", () => {
  it("scans once per newly resolved value rather than once per persistence boundary", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      let repairTransactions = 0;
      const transact = store.transact.bind(store);
      store.transact = async (fn) => {
        repairTransactions += 1;
        return transact(fn);
      };
      const resolved = new Set(["first-secret"]);
      await repairGlobalAuditsForNewSecrets(
        store,
        identityRedactFn,
        resolved,
      );
      await repairGlobalAuditsForNewSecrets(
        store,
        identityRedactFn,
        resolved,
      );
      resolved.add("second-secret");
      await repairGlobalAuditsForNewSecrets(
        store,
        identityRedactFn,
        resolved,
      );
      expect(repairTransactions).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("repairs an unconsumed signal audit while its protected original remains matchable", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const signal = {
        id: "early-signal",
        name: "late-secret",
        correlationId: "late-secret",
        payload: { value: "late-secret" },
        receivedAt: "2026-07-29T00:00:00.000Z",
      };
      await store.signals.append(signal);
      await repairGlobalAuditsForNewSecrets(
        store,
        (record, refs) => {
          let json = JSON.stringify(record);
          for (const value of refs) {
            json = json.replaceAll(value, "[REDACTED]");
          }
          return JSON.parse(json);
        },
        new Set(["late-secret"]),
      );

      expect(JSON.stringify(await store.signals.list())).not.toContain(
        "late-secret",
      );
      await expect(
        store.signals.findUnconsumedMatch(
          "late-secret",
          "late-secret",
        ),
      ).resolves.toEqual(signal);
    } finally {
      await cleanup();
    }
  });

  it("reconstructs required signal fields when the redactor also scans object keys", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const signal = {
        id: "key-scanned-signal",
        name: "name",
        correlationId: "correlation",
        payload: { name: "name" },
        receivedAt: "2026-07-29T00:00:00.000Z",
      };
      await store.signals.append(signal);
      await repairGlobalAuditsForNewSecrets(
        store,
        (record, refs) => {
          let json = JSON.stringify(record);
          for (const value of refs) {
            json = json.replaceAll(value, "[REDACTED]");
          }
          return JSON.parse(json);
        },
        new Set(["name"]),
      );

      const [audit] = await store.signals.list();
      expect(audit).toMatchObject({
        id: signal.id,
        name: "[REDACTED]",
        correlationId: signal.correlationId,
      });
      expect(audit).toHaveProperty("payload");
      expect(JSON.stringify(audit)).not.toContain(':"name"');
      await expect(
        store.signals.findUnconsumedMatch(
          signal.name,
          signal.correlationId,
        ),
      ).resolves.toEqual(signal);
    } finally {
      await cleanup();
    }
  });

  it("reconstructs artifact audit fields when a secret equals a field name", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const artifact = {
        id: "key-scanned-artifact",
        runId: "run-artifact",
        name: "name",
        kind: "report",
        mime: "text/plain",
        path: "name/report.txt",
        bytes: 4,
        createdAt: "2026-07-29T00:00:00.000Z",
      };
      await store.artifacts.put(
        artifact,
        new TextEncoder().encode("name"),
      );
      await repairGlobalAuditsForNewSecrets(
        store,
        (record, refs) => {
          let json = JSON.stringify(record);
          for (const value of refs) {
            json = json.replaceAll(value, "[REDACTED]");
          }
          return JSON.parse(json);
        },
        new Set(["name"]),
      );

      const audit = await store.artifacts.getMetadata(artifact.id);
      expect(audit).toMatchObject({
        id: artifact.id,
        name: "[REDACTED]",
        kind: artifact.kind,
        mime: artifact.mime,
        path: "[REDACTED]",
      });
      expect(() => RunRecordSchema.shape.artifacts.parse([audit])).not.toThrow();
      expect(JSON.stringify(audit)).not.toContain(':"name"');
    } finally {
      await cleanup();
    }
  });

  it("withholds a non-text artifact when its byte count is a secret while retaining it for later repair", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const artifact = {
        id: "secret-sized-artifact",
        runId: "run-secret-sized-artifact",
        name: "opaque.bin",
        kind: "file",
        mime: "application/octet-stream",
        path: "opaque.bin",
        bytes: 42,
        createdAt: "2026-07-29T00:00:00.000Z",
      };
      const bytes = new Uint8Array(42).fill(7);
      await store.artifacts.put(artifact, bytes);
      const redact = (
        record: unknown,
        refs: ReadonlySet<string>,
      ): unknown =>
        typeof record === "number" &&
        refs.has(String(record))
          ? "[REDACTED]"
          : record;
      const resolved = new Set(["42"]);

      await repairGlobalAuditsForNewSecrets(
        store,
        redact,
        resolved,
      );

      await expect(
        store.artifacts.getMetadata(artifact.id),
      ).resolves.toBeUndefined();
      await expect(
        store.artifacts.getBytes(artifact.id),
      ).resolves.toBeUndefined();
      await expect(
        store.artifacts.listByRun(artifact.runId),
      ).resolves.toEqual([]);
      await expect(
        store.artifacts.listForRedaction(artifact.runId),
      ).resolves.toEqual([
        { artifact, auditVisible: false },
      ]);
      await expect(
        store.artifacts.getBytesForRedaction(artifact.id),
      ).resolves.toEqual(bytes);

      resolved.add("later-secret");
      await repairGlobalAuditsForNewSecrets(
        store,
        redact,
        resolved,
      );
      await expect(
        store.artifacts.getMetadata(artifact.id),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("withholds whole late-repaired leaves so a longer overlapping secret cannot expose a suffix", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const run = fixtureRun({
        runId: "overlapping-terminal",
        status: "completed",
        trace: [
          {
            seq: 0,
            stepId: "emit",
            block: "test.emit",
            status: "completed",
            inputs: {},
            outputs: { value: "abcdef" },
            startedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
        outputs: { value: "abcdef" },
        endedAt: "2026-07-29T00:00:00.000Z",
      });
      await store.runs.put(run);
      await store.artifacts.put(
        {
          id: "overlapping-artifact",
          runId: run.runId,
          name: "report.txt",
          kind: "report",
          mime: "text/plain",
          path: "report.txt",
          bytes: 6,
          createdAt: "2026-07-29T00:00:00.000Z",
        },
        new TextEncoder().encode("abcdef"),
      );
      const redact = (
        record: unknown,
        refs: ReadonlySet<string>,
      ): unknown => {
        let json = JSON.stringify(record);
        for (const value of [...refs].sort(
          (left, right) => right.length - left.length,
        )) {
          json = json.replaceAll(value, "[REDACTED]");
        }
        return JSON.parse(json);
      };
      const resolved = new Set(["abc"]);
      await repairGlobalAuditsForNewSecrets(
        store,
        redact,
        resolved,
      );
      resolved.add("abcdef");
      await repairGlobalAuditsForNewSecrets(
        store,
        redact,
        resolved,
      );

      const publicRun = await store.runs.get(run.runId);
      expect(publicRun?.trace[0]?.outputs).toEqual({
        value: "[REDACTED]",
      });
      const artifactBytes = await store.artifacts.getBytes(
        "overlapping-artifact",
      );
      expect(
        new TextDecoder().decode(artifactBytes),
      ).toBe("[REDACTED]");
    } finally {
      await cleanup();
    }
  });

  it("repairs correction-derived eval examples while retaining the exact correction target sealed", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const secret = "late-secret";
      const run = fixtureRun({
        runId: "run-correction-eval",
        status: "completed",
        trace: [
          {
            seq: 0,
            stepId: "extract",
            block: "test.extract",
            status: "completed",
            inputs: {},
            outputs: { [secret]: "wrong" },
            startedAt: "t",
          },
        ],
        endedAt: "t",
      });
      await store.runs.put(run);
      const correction = {
        runId: run.runId,
        stepId: "extract",
        fieldPath: `outputs.${secret}`,
        observed: `wrong-${secret}`,
        corrected: `right-${secret}`,
        reason: `replace ${secret}`,
        reviewer: "alice",
        createdAt: "2026-07-30T00:00:00.000Z",
      };
      await store.corrections.put(correction, {
        stepId: correction.stepId,
        fieldPath: correction.fieldPath,
      });
      const example = {
        id: `ex_${secret}`,
        suiteId: "suite-correction",
        sourceRunId: run.runId,
        input: {
          stepId: correction.stepId,
          fieldPath: correction.fieldPath,
          observed: correction.observed,
        },
        expected: correction.corrected,
        createdFromCorrection: `${correction.runId}:${correction.stepId}:${correction.fieldPath}`,
      };
      const suite = {
        id: example.suiteId,
        name: "Correction regression",
        examples: [example],
        scorer: { id: "exact", kind: "exact_match" },
        tags: [],
      };
      await store.evals.putSuite(suite);
      await store.evals.putExample(example);
      await store.evals.putExample({
        ...example,
        id: `orphan_${secret}`,
        suiteId: "suite-not-yet-created",
      });
      await store.evals.putRun({
        id: "eval-run",
        suiteId: suite.id,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        status: "failed",
        total: 1,
        passed: 0,
        failed: 1,
        score: 0,
        regressions: [example.id],
        improvements: [],
        reportArtifact: "report",
      });

      await repairGlobalAuditsForNewSecrets(
        store,
        (record, refs) => {
          let json = JSON.stringify(record);
          for (const value of refs) {
            json = json.replaceAll(value, "[REDACTED]");
          }
          return JSON.parse(json);
        },
        new Set([secret]),
      );

      const [publicCorrection] =
        await store.corrections.list({
          runId: run.runId,
        });
      expect(publicCorrection).toBeDefined();
      expect(
        JSON.stringify(publicCorrection),
      ).not.toContain(secret);
      await expect(
        store.corrections.getOperationalTarget(
          publicCorrection!,
        ),
      ).resolves.toEqual({
        stepId: correction.stepId,
        fieldPath: correction.fieldPath,
      });
      const publicEvalState = {
        examples: await store.evals.listExamples(),
        suites: await store.evals.listSuites(),
        runs: await store.evals.listRuns(),
      };
      expect(
        JSON.stringify(publicEvalState),
      ).not.toContain(secret);
      expect(
        publicEvalState.runs[0]?.regressions,
      ).toEqual([
        publicEvalState.examples.find(
          (candidate) =>
            candidate.suiteId === suite.id,
        )?.id,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("archives a legacy terminal snapshot before its first late-secret public rewrite", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const secret = "legacy-snapshot-secret";
      const exactDefinitions = {
        id: "legacy-workflow",
        name: secret,
        version: "1.0.0",
        inputs: [],
        outputs: [],
        execution: {
          type: "workflow",
          steps: [],
        },
        approval: "approved",
        gates: {
          validate: "passed",
          readiness: "passed",
          evals: "passed",
          riskReview: "passed",
          humanReview: "passed",
        },
      };
      const run = fixtureRun({
        runId: "legacy-terminal-no-archive",
        workflowId: exactDefinitions.id,
        workflowVersion: exactDefinitions.version,
        status: "completed",
        snapshot: {
          definitions: exactDefinitions,
          resolvedVersions: {},
          packHashes: {},
          capturedAt: "2026-07-30T00:00:00.000Z",
        },
        endedAt: "2026-07-30T00:00:00.000Z",
      });
      await store.runs.put(run);
      await expect(
        store.runs.getOperationalState(run.runId),
      ).resolves.toBeUndefined();

      await repairGlobalAuditsForNewSecrets(
        store,
        (record, refs) => {
          let json = JSON.stringify(record);
          for (const value of refs) {
            json = json.replaceAll(value, "[REDACTED]");
          }
          return JSON.parse(json);
        },
        new Set([secret]),
      );

      expect(
        JSON.stringify(await store.runs.get(run.runId)),
      ).not.toContain(secret);
      await expect(
        store.runs.getOperationalState(run.runId),
      ).resolves.toMatchObject({
        run: {
          snapshot: {
            definitions: exactDefinitions,
          },
        },
        resolvedSecretValues: [secret],
      });
    } finally {
      await cleanup();
    }
  });
});

describe("redactWaitAudit", () => {
  it("preserves every union member's structural fields under key-scanning redaction", () => {
    const waits: WaitCondition[] = [
      { type: "approval", taskId: "taskId", timeout: "timeout", schemaVersion: 2 },
      { type: "signal", name: "name", correlationId: "correlationId", timeout: "timeout", schemaVersion: 2 },
      { type: "timer", resumeAt: "resumeAt", schemaVersion: 2 },
      { type: "webhook", event: "event", correlationId: "correlationId", timeout: "timeout", schemaVersion: 2 },
      { type: "external_job", provider: "provider", jobId: "jobId", timeout: "timeout", schemaVersion: 2 },
      { type: "queue", queue: "queue", correlationId: "correlationId", timeout: "timeout", schemaVersion: 2 },
      { type: "manual", timeout: "timeout", schemaVersion: 2 },
    ];
    const structuralNames = new Set([
      "taskId",
      "name",
      "correlationId",
      "timeout",
      "resumeAt",
      "event",
      "provider",
      "jobId",
      "queue",
    ]);
    const keyScanningRedactor = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown => {
      let json = JSON.stringify(record);
      for (const value of refs) {
        json = json.replaceAll(value, "[REDACTED]");
      }
      return JSON.parse(json);
    };

    for (const wait of waits) {
      const audit = redactWaitAudit(
        keyScanningRedactor,
        wait,
        structuralNames,
      );
      expect(() => WaitConditionSchema.parse(audit)).not.toThrow();
      expect(Object.keys(audit)).not.toContain("[REDACTED]");
      for (const [field, fieldValue] of Object.entries(audit)) {
        if (field === "type" || field === "schemaVersion") continue;
        expect(fieldValue).toBe("[REDACTED]");
      }
    }
  });
});

describe("throwingSecretResolver", () => {
  it("throws SecretResolutionError when no real resolver was configured", async () => {
    await expect(Promise.resolve().then(() => throwingSecretResolver("API_KEY"))).rejects.toThrow(SecretResolutionError);
  });
});

describe("createTrackingSecretResolver", () => {
  it("delegates to the wrapped resolver and returns its value", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => `value-of-${name}`, resolvedRefs);
    await expect(tracking("API_KEY")).resolves.toBe("value-of-API_KEY");
  });

  // S9 integration fix (see this function's own doc comment + root
  // AMENDMENTS.md's dedicated entry): this used to track the resolved
  // NAME ("API_KEY") instead of the resolved VALUE ("value-of-API_KEY") -
  // silently defeating @aart/governance's real redactRecord, which scans
  // for literal VALUE occurrences per its own documented contract. Caught
  // by a genuine end-to-end test against the real redactRecord
  // (packages/mcp/src/real-context.test.ts), not this package's own mocks.
  it("records every successfully-resolved VALUE into the shared set (architecture §7.9's 'resolved secret refs' set — 'populated... at the moment the resolver returns A VALUE')", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => `value-of-${name}`, resolvedRefs);
    await tracking("API_KEY");
    await tracking("DB_PASSWORD");
    expect(resolvedRefs).toEqual(new Set(["value-of-API_KEY", "value-of-DB_PASSWORD"]));
  });

  it("does NOT track the resolved value when the wrapped resolver returns undefined (Set<string> - only defined string values are trackable/redactable)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => undefined, resolvedRefs);
    await tracking("MAYBE_MISSING");
    expect(resolvedRefs.size).toBe(0);
  });

  it("does NOT track a resolved null (root AMENDMENTS.md F2 fix: null/undefined are never 'a value' to protect — tracking the literal string \"null\" would over-redact every ordinary null field in every run)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => null, resolvedRefs);
    await tracking("MAYBE_NULL");
    expect(resolvedRefs.size).toBe(0);
  });

  // ---- F2 fix (root AMENDMENTS.md, S10 completion): SecretResolver is
  // typed `=> unknown` — a resolver adapter can legitimately return a raw
  // numeric OTP/PIN or boolean flag, not just a string. Before this fix,
  // only `typeof value === "string"` was ever tracked, so a genuinely
  // non-string secret never entered @aart/governance's redactRecord scan
  // set at all, even where the SAME value later appeared as a plain string
  // elsewhere in a persisted record (see packages/governance/src/
  // redact-adversarial.test.ts's "[SAFE: F2]" cases for that half).
  it("[F2] tracks the canonical STRING form of a resolved NUMBER value", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => 782341, resolvedRefs);
    await tracking("OTP");
    expect(resolvedRefs).toEqual(new Set(["782341"]));
  });

  it("[F2] tracks the canonical STRING form of a resolved BOOLEAN value", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => true, resolvedRefs);
    await tracking("FEATURE_FLAG_SECRET");
    expect(resolvedRefs).toEqual(new Set(["true"]));
  });

  it("[F2] does NOT track a resolved object/array (a composite isn't itself a flat scalar secret to string-match against)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => ({ nested: "value" }), resolvedRefs);
    await tracking("SOME_OBJECT");
    expect(resolvedRefs.size).toBe(0);
  });

  it("accumulates across multiple calls within the same set (segment-scoped, not per-call)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async (name) => name, resolvedRefs);
    await tracking("A");
    await tracking("B");
    await tracking("A"); // re-resolved — Set naturally dedupes
    expect(resolvedRefs.size).toBe(2);
  });

  it("does NOT record a name if the wrapped resolver throws (only successful resolutions are tracked)", async () => {
    const resolvedRefs = new Set<string>();
    const tracking = createTrackingSecretResolver(async () => {
      throw new SecretResolutionError({ message: "no value" });
    }, resolvedRefs);
    await expect(tracking("MISSING")).rejects.toThrow(SecretResolutionError);
    expect(resolvedRefs.size).toBe(0);
  });
});

describe("applyRedaction", () => {
  it("calls the injected RedactFn with the record and the resolvedSecretRefs set, and returns its result", () => {
    const refs = new Set(["API_KEY"]);
    let seenArgs: unknown[] = [];
    const fakeRedact = (record: unknown, resolvedSecretRefs: ReadonlySet<string>) => {
      seenArgs = [record, resolvedSecretRefs];
      return { ...(record as object), redacted: true };
    };
    const result = applyRedaction(fakeRedact, { value: "raw" }, refs);
    expect(seenArgs[0]).toEqual({ value: "raw" });
    expect(seenArgs[1]).toBe(refs);
    expect(result).toEqual({ value: "raw", redacted: true });
  });

  it("a non-identity redactor's value-scan-and-replace behavior is visible through this call site (routing is real, not merely declared)", () => {
    const refs = new Set(["shh-secret-value"]);
    const scanAndReplaceRedact = (record: unknown, resolvedSecretRefs: ReadonlySet<string>): unknown => {
      let json = JSON.stringify(record);
      for (const ref of resolvedSecretRefs) {
        json = json.split(ref).join("[REDACTED]");
      }
      return JSON.parse(json);
    };
    const result = applyRedaction(scanAndReplaceRedact, { outputs: { echoed: "the value is shh-secret-value here" } }, refs);
    expect(JSON.stringify(result)).not.toContain("shh-secret-value");
    expect((result as { outputs: { echoed: string } }).outputs.echoed).toBe("the value is [REDACTED] here");
  });
});

describe("applyRunRedaction", () => {
  const redactKey = (record: unknown): unknown =>
    JSON.parse(JSON.stringify(record).replaceAll("case-secret", "[REDACTED]"));
  const redactResolved = (
    record: unknown,
    refs: ReadonlySet<string>,
  ): unknown => {
    let json = JSON.stringify(record);
    for (const ref of refs) json = json.replaceAll(ref, "[REDACTED]");
    return JSON.parse(json);
  };

  it("withholds schema-constrained numeric call metrics instead of copying numeric secrets", () => {
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: "llm",
          block: "llm.call",
          status: "completed",
          inputs: {},
          outputs: { ok: true },
          startedAt: "2026-07-29T00:00:00.000Z",
          durationMs: 42,
          llmCall: {
            provider: "provider",
            model: "model",
            promptRef: "prompt",
            promptVersion: "1",
            tokensIn: 42,
            tokensOut: 42,
            latencyMs: 42,
            costEstimate: 42,
          },
          externalCalls: [
            {
              system: "api",
              domain: "example.com",
              status: 42,
              durationMs: 42,
            },
          ],
        },
      ],
    });

    const numericRedact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown => {
      if (
        (typeof record === "number" ||
          typeof record === "boolean" ||
          typeof record === "string") &&
        refs.has(String(record))
      ) {
        return "[REDACTED]";
      }
      if (Array.isArray(record)) {
        return record.map((value) =>
          numericRedact(value, refs)
        );
      }
      if (record !== null && typeof record === "object") {
        return Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            numericRedact(value, refs),
          ]),
        );
      }
      return record;
    };
    const publicRun = applyRunRedaction(
      numericRedact,
      run,
      new Set(["42"]),
    );

    expect(publicRun.trace[0]).not.toHaveProperty("durationMs");
    expect(publicRun.trace[0]).not.toHaveProperty("llmCall");
    expect(publicRun.trace[0]?.externalCalls).toEqual([]);
    expect(
      JSON.stringify({
        inputs: publicRun.inputs,
        outputs: publicRun.outputs,
        trace: publicRun.trace,
        artifacts: publicRun.artifacts,
      }),
    ).not.toContain("42");
    expect(() => RunRecordSchema.parse(publicRun)).not.toThrow();
  });

  it("withholds artifact audit rows whose required byte count is a numeric secret", () => {
    const artifact = {
      id: "numeric-artifact",
      runId: "numeric-run",
      stepId: "write",
      name: "result.txt",
      kind: "report",
      mime: "text/plain",
      path: "artifacts/numeric-run/numeric-artifact",
      bytes: 42,
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const run = fixtureRun({
      runId: artifact.runId,
      artifacts: [artifact],
      trace: [
        {
          seq: 0,
          stepId: "write",
          block: "test.write",
          status: "completed",
          inputs: {},
          artifacts: [artifact],
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    const numericRedact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown =>
      typeof record === "number" && refs.has(String(record))
        ? "[REDACTED]"
        : record;

    const publicRun = applyRunRedaction(
      numericRedact,
      run,
      new Set(["42"]),
    );

    expect(publicRun.artifacts).toEqual([]);
    expect(publicRun.trace[0]?.artifacts).toEqual([]);
    expect(
      JSON.stringify({
        trace: publicRun.trace,
        artifacts: publicRun.artifacts,
      }),
    ).not.toContain("42");
    expect(() => RunRecordSchema.parse(publicRun)).not.toThrow();
  });

  it("preserves literal trace-artifact schema keys when a secret matches a field name", () => {
    const artifact = {
      id: "key-artifact",
      runId: "key-run",
      stepId: "write",
      name: "name",
      kind: "report",
      mime: "text/plain",
      path: "name/result.txt",
      bytes: 4,
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const run = fixtureRun({
      runId: artifact.runId,
      trace: [
        {
          seq: 0,
          stepId: "write",
          block: "test.write",
          status: "completed",
          inputs: {},
          artifacts: [artifact],
          startedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });

    const publicRun = applyRunRedaction(
      redactResolved,
      run,
      new Set(["name"]),
    );

    expect(publicRun.trace[0]?.artifacts?.[0]).toMatchObject({
      name: "[REDACTED]",
      path: "[REDACTED]",
    });
    expect(publicRun.trace[0]?.artifacts?.[0]).toHaveProperty(
      "mime",
      "text/plain",
    );
    expect(() => RunRecordSchema.parse(publicRun)).not.toThrow();
  });

  it("omits a secret-valued optional LLM cost while retaining otherwise safe metrics", () => {
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: "llm",
          block: "llm.call",
          status: "completed",
          inputs: {},
          outputs: { ok: true },
          startedAt: "2026-07-29T00:00:00.000Z",
          llmCall: {
            provider: "provider",
            model: "model",
            promptRef: "prompt",
            promptVersion: "1",
            tokensIn: 10,
            tokensOut: 20,
            latencyMs: 30,
            costEstimate: 42,
          },
        },
      ],
    });
    const numericRedact = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown =>
      typeof record === "number" &&
      refs.has(String(record))
        ? "[REDACTED]"
        : record;

    const publicRun = applyRunRedaction(
      numericRedact,
      run,
      new Set(["42"]),
    );

    expect(publicRun.trace[0]?.llmCall).toMatchObject({
      tokensIn: 10,
      tokensOut: 20,
      latencyMs: 30,
    });
    expect(publicRun.trace[0]?.llmCall).not.toHaveProperty(
      "costEstimate",
    );
    expect(JSON.stringify(publicRun.trace)).not.toContain("42");
  });

  it("fingerprints a non-terminal concurrency key once its raw value becomes secret", () => {
    const run = fixtureRun({
      status: "running",
      params: { concurrencyKey: "case-secret", concurrencyKeyFormat: "legacy-compatible" },
    });

    const redacted = applyRunRedaction(redactKey, run, new Set(["case-secret"]));

    expect(redacted.params?.concurrencyKey).toMatch(/^sha256:/);
    expect(redacted.params?.concurrencyKey).not.toContain(
      "case-secret",
    );
    expect(redacted.params?.concurrencyKeyFormat).toBe("sha256-v1");
  });

  it("fully redacts the concurrency key after the run becomes terminal", () => {
    const run = fixtureRun({ status: "completed", params: { concurrencyKey: "case-secret" } });

    const redacted = applyRunRedaction(redactKey, run, new Set(["case-secret"]));

    expect(redacted.params?.concurrencyKey).toBe("[REDACTED]");
  });

  it("keeps secret taint metadata outside key and boolean value redaction", () => {
    const hostileMetadataRedactor = (record: unknown): unknown => {
      const visit = (value: unknown): unknown => {
        if (value === true) return "[REDACTED:true]";
        if (Array.isArray(value)) return value.map(visit);
        if (value !== null && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
              key.replaceAll("secret", "[REDACTED:secret]"),
              visit(nested),
            ]),
          );
        }
        return value;
      };
      return visit(record);
    };
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: "source",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "[REDACTED]" },
          startedAt: "2026-07-28T00:00:00.000Z",
          secretTainted: true,
        },
      ],
    });

    const redacted = applyRunRedaction(
      hostileMetadataRedactor,
      run,
      new Set(["secret", "true"]),
    );

    expect(redacted.trace[0]?.secretTainted).toBe(true);
    expect(redacted.trace[0]).not.toHaveProperty("[REDACTED:secret]Tainted");
  });

  it("keeps RunRecord structural fields schema-valid when boolean and numeric secrets collide with them", () => {
    const hostileScalarRedactor = (
      record: unknown,
      refs: ReadonlySet<string>,
    ): unknown => {
      const visit = (value: unknown): unknown => {
        if (
          (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean") &&
          refs.has(String(value))
        ) {
          return "[REDACTED]";
        }
        if (Array.isArray(value)) return value.map(visit);
        if (value !== null && typeof value === "object") {
          return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [
              key,
              visit(nested),
            ]),
          );
        }
        return value;
      };
      return visit(record);
    };
    const run = fixtureRun({
      approved: true,
      schemaVersion: 2,
      params: {
        dryRun: true,
        waitingOnConcurrency: true,
        environment: "true",
        concurrencyKeyFormat: "2",
      },
      snapshot: {
        definitions: {
          execution: { enabled: true, revision: 2 },
        },
        resolvedVersions: {},
        packHashes: {},
        capturedAt: "2026-07-29T00:00:00.000Z",
      },
    });

    const redacted = applyRunRedaction(
      hostileScalarRedactor,
      run,
      new Set(["true", "2"]),
    );

    expect(redacted.approved).toBe(true);
    expect(redacted.schemaVersion).toBe(2);
    expect(redacted.params).toMatchObject({
      dryRun: true,
      waitingOnConcurrency: true,
      environment: "[REDACTED]",
      concurrencyKeyFormat: "2",
    });
    expect(redacted.snapshot.definitions).toBeNull();
    expect(() => RunRecordSchema.parse(redacted)).not.toThrow();
  });

  it("keeps the top-level trace container outside key redaction", () => {
    const redactTraceKey = (record: unknown): unknown =>
      JSON.parse(JSON.stringify(record).replaceAll("trace", "[REDACTED]"));
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: "source",
          block: "test.echo",
          status: "completed",
          inputs: {},
          outputs: { value: "public" },
          startedAt: "t",
        },
      ],
    });

    const redacted = applyRunRedaction(
      redactTraceKey,
      run,
      new Set(["trace"]),
    );

    expect(redacted.trace).toHaveLength(1);
    expect(redacted).not.toHaveProperty("[REDACTED]");
  });

  it("preserves authored execution identity while redacting data-bearing trace fields", () => {
    const structuralValue = "coincidental-secret";
    const run = fixtureRun({
      trace: [
        {
          seq: 0,
          stepId: structuralValue,
          authoredStepId: structuralValue,
          block: structuralValue,
          status: "failed",
          inputs: { value: structuralValue },
          outputs: { value: structuralValue },
          error: `failed with ${structuralValue}`,
          startedAt: structuralValue,
          endedAt: structuralValue,
          durationMs: 0,
        },
      ],
    });
    (
      run.trace[0] as StepTrace & {
        futureDataBearingField: string;
      }
    ).futureDataBearingField = structuralValue;
    const redacted = applyRunRedaction(
      redactResolved,
      run,
      new Set([structuralValue]),
    );

    expect(redacted.trace[0]).toMatchObject({
      stepId: structuralValue,
      authoredStepId: structuralValue,
      block: structuralValue,
      startedAt: structuralValue,
      endedAt: structuralValue,
      inputs: { value: "[REDACTED]" },
      outputs: { value: "[REDACTED]" },
      error: "[REDACTED]",
      secretTainted: true,
    });
    expect(redacted.trace[0]).not.toHaveProperty(
      "futureDataBearingField",
    );
  });

  it("collapses persisted root pointers when a later secret matches a path segment", () => {
    const firstPass = applyRunRedaction(
      redactResolved,
      fixtureRun({
        inputs: { "future-secret": "first-secret" },
        trigger: {
          type: "manual",
          id: "trigger",
          source: "test",
          payload: { "future-secret": "first-secret" },
          receivedAt: "2026-07-29T00:00:00.000Z",
        },
        trace: [
          {
            seq: 0,
            stepId: "source",
            block: "test.echo",
            status: "completed",
            inputs: {},
            outputs: { "future-secret": "first-secret" },
            startedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      }),
      new Set(["first-secret"]),
    );
    expect(firstPass.secretTaintedInputPaths).toEqual(["/future-secret"]);
    expect(firstPass.secretTaintedTriggerPaths).toEqual([
      "/payload/future-secret",
    ]);
    expect(firstPass.trace[0]?.secretTaintedPaths).toEqual([
      "/future-secret",
    ]);

    const secondPass = applyRunRedaction(
      redactResolved,
      firstPass,
      new Set(["future-secret"]),
    );

    expect(secondPass.secretTaintedInputPaths).toEqual(["*"]);
    expect(secondPass.secretTaintedTriggerPaths).toEqual(["*"]);
    expect(secondPass.trace[0]?.secretTaintedPaths).toEqual(["*"]);
    expect(JSON.stringify(secondPass)).not.toContain("future-secret");
  });

  it("never persists a newly discovered pointer whose path already contains a secret", () => {
    const secretKey = "already-secret";
    const redacted = applyRunRedaction(
      redactResolved,
      fixtureRun({
        inputs: { [secretKey]: "public" },
        trigger: {
          type: "manual",
          id: "trigger",
          source: "test",
          payload: { [secretKey]: "public" },
          receivedAt: "2026-07-29T00:00:00.000Z",
        },
        trace: [
          {
            seq: 0,
            stepId: "source",
            block: "test.echo",
            status: "completed",
            inputs: {},
            outputs: { [secretKey]: "public" },
            startedAt: "2026-07-29T00:00:00.000Z",
          },
        ],
      }),
      new Set([secretKey]),
    );

    expect(redacted.secretTaintedInputPaths).toEqual(["*"]);
    // The trigger redactor detects the changed payload object at its parent
    // boundary, which is already a safe, conservative pointer.
    expect(redacted.secretTaintedTriggerPaths).toEqual(["/payload"]);
    expect(redacted.trace[0]?.secretTaintedPaths).toEqual(["*"]);
    expect(JSON.stringify(redacted)).not.toContain(secretKey);
  });
});

describe("mergePersistedRunTaint", () => {
  it("keeps newly prepared progress while importing a concurrently committed security repair", async () => {
    const { store, cleanup } = await createTestStore();
    try {
      const baseTrace: StepTrace = {
        seq: 0,
        stepId: "cached",
        block: "test.echo",
        status: "completed",
        inputs: {},
        outputs: { value: "raw-operational-value" },
        startedAt: "2026-07-29T00:00:00.000Z",
      };
      const repairedAudit = fixtureRun({
        runId: "merge-latest-taint",
        trace: [
          {
            ...baseTrace,
            outputs: { value: "[REDACTED]" },
            secretTainted: true,
            secretTaintedPaths: ["*"],
          },
        ],
      });
      await store.runs.put(repairedAudit);
      const prepared = fixtureRun({
        runId: repairedAudit.runId,
        trace: [
          baseTrace,
          {
            seq: 1,
            stepId: "next",
            block: "test.echo",
            status: "completed",
            inputs: {},
            outputs: { value: "new-progress" },
            startedAt: "2026-07-29T00:00:01.000Z",
          },
        ],
      });

      const merged = await mergePersistedRunTaint(
        store,
        prepared,
      );

      expect(merged.trace).toHaveLength(2);
      expect(merged.trace[0]).toMatchObject({
        outputs: { value: "raw-operational-value" },
        secretTainted: true,
        secretTaintedPaths: ["*"],
      });
      expect(merged.trace[1]?.outputs).toEqual({
        value: "new-progress",
      });
    } finally {
      await cleanup();
    }
  });
});
