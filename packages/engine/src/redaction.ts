// Redaction routing (architecture §4.2/§4.4 step 3/§4.6/§7.9, F2 chokepoint
// fix) — the engine routes EVERY StepTrace/RunRecord/wait-checkpoint persist
// through the constructor-injected `RedactFn`, threading in the claimed
// run's currently-resolved secret-refs set fresh on every call. This module
// is the one place that threading happens; every persist call site in this
// package goes through `applyRedaction`, never `config.redact` directly.
import { randomUUID } from "node:crypto";
import type { SecretResolver } from "@aart/expr";
import type {
  AartStore,
  ArtifactRedactionCandidate,
} from "@aart/store";
import type {
  ApprovalTask,
  Artifact,
  Correction,
  EvalExample,
  RedactFn,
  RunRecord,
  Signal,
  StepTrace,
  WaitCondition,
} from "@aart/types";
import { SecretResolutionError } from "@aart/types";
import {
  CONCURRENCY_KEY_FORMAT,
  fingerprintConcurrencyKey,
} from "./concurrency.js";
import { idempotencyAssociationFingerprint } from "./idempotency-association.js";
import { jsonValuesEqual } from "./output-validation.js";

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function correctionAuditKey(
  correction: Pick<
    Correction,
    "runId" | "stepId" | "fieldPath"
  >,
): string {
  return `${correction.runId}:${correction.stepId}:${correction.fieldPath}`;
}

export function changedJsonPointers(
  before: unknown,
  after: unknown,
  path = "",
): string[] {
  if (jsonValuesEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [path || "*"];
    return before.flatMap((value, index) =>
      changedJsonPointers(value, after[index], `${path}/${index}`),
    );
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeRecord);
    const afterKeys = Object.keys(afterRecord);
    if (
      beforeKeys.length !== afterKeys.length ||
      beforeKeys.some((key) => !Object.hasOwn(afterRecord, key))
    ) {
      return [path || "*"];
    }
    return beforeKeys.flatMap((key) =>
      changedJsonPointers(
        beforeRecord[key],
        afterRecord[key],
        `${path}/${escapeJsonPointerSegment(key)}`,
      ),
    );
  }
  return [path || "*"];
}

/**
 * Identity `RedactFn` — this session's own tests wire this by default
 * (architecture §7.9: "Engine unit tests may wire an identity `RedactFn`
 * when redaction isn't what's under test"). A real composition root wires
 * `@aart/governance`'s `redactRecord` instead.
 */
export const identityRedactFn: RedactFn = (record) => record;

/**
 * F5 fix (root AMENDMENTS.md, S10 completion): decides whether an artifact's
 * declared MIME type is text — the boundary `step-executor.ts`'s
 * `writeArtifact` uses to decide whether artifact BYTES pass through the
 * redaction chokepoint before persist. Deliberately narrow and explicit
 * (not "assume text unless proven binary") — a false positive here would
 * mean attempting to UTF-8-decode genuinely binary bytes (corrupting them)
 * before re-encoding, which is worse than doing nothing.
 */
export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml");
}

/**
 * Default `resolveSecret` — throws if a workflow under test actually
 * references `secrets.*` without the engine being configured with a real
 * resolver (`EngineConfig.resolveSecret`). Kept as a loud failure rather
 * than a silent `undefined` so a missing-configuration bug in a test/
 * composition root surfaces immediately as a `SecretResolutionError`
 * (architecture §3.2/§31.2), the same error class a genuinely-missing
 * secret adapter value would raise.
 */
export const throwingSecretResolver: SecretResolver = (name) => {
  throw new SecretResolutionError({
    message: `secrets.${name} was referenced but no resolveSecret was configured on this Engine (EngineConfig.resolveSecret) — @aart/expr never resolves secrets.* itself (architecture §3.2/ADR-10).`,
    detail: { kind: "missingResolver", name },
  });
};

/**
 * F2 fix (root AMENDMENTS.md, S10 completion): stringifies the canonical
 * form of a resolved secret VALUE so it enters the tracked-refs set even
 * when the resolver's real return type isn't a string — `SecretResolver`
 * is typed `=> unknown` (a resolver adapter can legitimately return a raw
 * numeric OTP/PIN, a boolean flag, etc.), but before this fix only
 * `typeof value === "string"` was ever tracked, so a genuinely non-string
 * secret never entered the scan set at all — @aart/governance's
 * `redactRecord` had nothing to search for even where the SAME value later
 * appeared as a plain string elsewhere in a persisted record.
 *
 * Deliberately excludes `null`/`undefined` — neither is a "value" to
 * protect, and adding the literal string `"null"`/`"undefined"` to a
 * value-scan-and-replace set would redact every ordinary null/undefined-
 * shaped field in every run, a catastrophic over-redaction bug, not a fix.
 * Also excludes objects/arrays — a resolver returning a composite isn't
 * itself a flat scalar secret to string-match against; if a scalar leaf
 * inside it matters, the resolver should resolve to that scalar directly.
 */
function toCanonicalSecretString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/**
 * Wraps a real `SecretResolver` so that every VALUE it successfully
 * resolves is recorded into `resolvedRefs` (architecture §7.9: "a per-run
 * 'resolved secret refs' set populated at the moment @aart/expr's injected
 * secret resolver... returns a value" — literally the resolved VALUE, not
 * the symbolic name/ref that was looked up). `resolvedRefs` is scoped to
 * one execution segment (one `triggerRun`/`resumeWait` call, from wherever
 * it starts to wherever it stops at a wait/terminal status) — see
 * `engine.ts` for where a fresh `Set` is created per segment. Callers pass
 * the SAME set to every `applyRedaction` call made during that segment, so
 * a secret resolved by an earlier step is still redacted from a later
 * step's persisted output that happens to echo it back.
 *
 * S9 integration fix (found via a genuine end-to-end test against the REAL
 * @aart/governance redactRecord, not this package's own mocks — see
 * root AMENDMENTS.md's dedicated entry on this): this previously tracked
 * `name` (the symbolic ref/argument passed to the resolver) instead of
 * `value` (what the resolver actually returned). `@aart/governance`'s real
 * `redactRecord` — the frozen `RedactFn` contract's only real
 * implementation — scans a persisted record for literal occurrences of
 * each SET MEMBER, documented explicitly as "resolved secret VALUES (not
 * names)". Tracking names instead of values meant `resolvedSecretRefs`
 * held strings like `"API_KEY"` instead of the actual secret value that
 * could appear in output data — `redactRecord` would then search for the
 * literal substring `"API_KEY"` (which essentially never coincidentally
 * appears in real data) instead of the real secret value, so redaction
 * silently redacted NOTHING in the real merged system despite every test
 * in this package's own (pre-integration) suite passing — those tests used
 * mock redactors that derived their own search value FROM the tracked name
 * (e.g. `` `secret-value-for-${ref}` ``), which happened to round-trip
 * correctly against a same-shaped mock resolver without ever exercising
 * the real value-based contract. This is exactly the class of bug a
 * hardening wave's genuine cross-package integration testing exists to
 * catch that per-package testing against fakes structurally cannot.
 */
export function createTrackingSecretResolver(resolver: SecretResolver, resolvedRefs: Set<string>): SecretResolver {
  return async (name: string) => {
    const value = await resolver(name);
    const canonical = toCanonicalSecretString(value);
    if (canonical !== undefined) resolvedRefs.add(canonical);
    return value;
  };
}

/**
 * The one call site every persist/emit path in this package routes through
 * (architecture §7.9's diagram, engine row). Never call `config.redact`
 * directly from elsewhere in this package — route through this function so
 * the "redaction happens between block-produced-raw-output and
 * trace-entry-persisted, not only at report-render time" discipline
 * (architecture micro-decision #29) is enforced structurally, in one place.
 */
export function applyRedaction<T>(redact: RedactFn, record: T, resolvedSecretRefs: ReadonlySet<string>): T {
  return redact(record, resolvedSecretRefs) as T;
}

/**
 * Irreversible public persistence cannot assume that a future, longer secret
 * will still be reconstructible after a shorter overlapping value is removed.
 * Once any scalar leaf or object key matches, withhold that whole leaf/key
 * instead of retaining adjacent text that a later discovery could reveal
 * as the suffix of the longer secret.
 */
function conservativePublicRedact(base: RedactFn): RedactFn {
  const walk = (
    value: unknown,
    resolvedSecretRefs: ReadonlySet<string>,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, resolvedSecretRefs));
    }
    if (
      value !== null &&
      typeof value === "object"
    ) {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const candidateKey = base(
          key,
          resolvedSecretRefs,
        );
        const rootKey =
          candidateKey === key ? key : "[REDACTED]";
        let safeKey = rootKey;
        let collision = 1;
        while (Object.hasOwn(output, safeKey)) {
          safeKey = `${rootKey}#${collision}`;
          collision += 1;
        }
        Object.defineProperty(output, safeKey, {
          value: walk(child, resolvedSecretRefs),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    }
    const redacted = base(value, resolvedSecretRefs);
    return jsonValuesEqual(redacted, value)
      ? value
      : "[REDACTED]";
  };
  return (record, resolvedSecretRefs) =>
    walk(record, resolvedSecretRefs);
}

export function applyConservativeRedaction<T>(
  redact: RedactFn,
  record: T,
  resolvedSecretRefs: ReadonlySet<string>,
): T {
  return conservativePublicRedact(redact)(
    record,
    resolvedSecretRefs,
  ) as T;
}

/**
 * Re-scans every text artifact for a run whenever the execution segment
 * learns another secret value. Artifact bytes are persisted before later
 * steps/control expressions run, so write-time redaction alone cannot cover
 * a value that only becomes known to be secret afterward.
 */
export async function redactStoredTextArtifacts(
  store: Pick<AartStore, "artifacts">,
  redact: RedactFn,
  runId: string,
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<Artifact[]> {
  const artifacts =
    await store.artifacts.listForRedaction(runId);
  return redactStoredArtifacts(
    store,
    redact,
    artifacts,
    resolvedSecretRefs,
  );
}

async function redactStoredArtifacts(
  store: Pick<AartStore, "artifacts">,
  redact: RedactFn,
  artifacts: ArtifactRedactionCandidate[],
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<Artifact[]> {
  if (resolvedSecretRefs.size === 0) {
    return artifacts.flatMap(({ artifact, auditVisible }) =>
      auditVisible ? [artifact] : [],
    );
  }
  redact = conservativePublicRedact(redact);

  const refreshed: Artifact[] = [];
  for (const candidate of artifacts) {
    const { artifact } = candidate;
    const audit = redactArtifactAudit(
      redact,
      artifact,
      resolvedSecretRefs,
    );
    let redactedBytes: Uint8Array | undefined;
    if (await store.artifacts.isTextEligible(artifact.id)) {
      const bytes =
        await store.artifacts.getBytesForRedaction(artifact.id);
      if (bytes !== undefined) {
        const rawText = new TextDecoder().decode(bytes);
        const redactedText = applyRedaction(
          redact,
          rawText,
          resolvedSecretRefs,
        );
        if (redactedText !== rawText) {
          redactedBytes = new TextEncoder().encode(redactedText);
        }
      }
    }
    const auditChanged =
      JSON.stringify(audit) !==
      JSON.stringify({
        name: artifact.name,
        kind: artifact.kind,
        mime: artifact.mime,
        path: artifact.path,
      });
    const finalByteCount =
      redactedBytes?.byteLength ?? artifact.bytes;
    const auditVisible =
      candidate.auditVisible &&
      redactAuditNumber(
        redact,
        finalByteCount,
        resolvedSecretRefs,
      ) !== undefined;
    if (
      !auditChanged &&
      redactedBytes === undefined &&
      auditVisible === candidate.auditVisible
    ) {
      if (auditVisible) refreshed.push(artifact);
      continue;
    }
    const updated = await store.artifacts.replaceAudit(
      artifact.id,
      audit,
      redactedBytes,
      auditVisible ? undefined : { auditVisible: false },
    );
    if (auditVisible) refreshed.push(updated ?? artifact);
  }
  return refreshed;
}

function redactArtifactAudit(
  redact: RedactFn,
  artifact: Pick<Artifact, "name" | "kind" | "mime" | "path">,
  resolvedSecretRefs: ReadonlySet<string>,
): Pick<Artifact, "name" | "kind" | "mime" | "path"> {
  redact = conservativePublicRedact(redact);
  // Artifact field names are schema, not customer data. Rebuild each
  // literal key so a redactor that scans object keys cannot remove a
  // required field and make an adapter preserve stale plaintext.
  return {
    name: applyRedaction(
      redact,
      artifact.name,
      resolvedSecretRefs,
    ) as string,
    kind: applyRedaction(
      redact,
      artifact.kind,
      resolvedSecretRefs,
    ) as string,
    mime: applyRedaction(
      redact,
      artifact.mime,
      resolvedSecretRefs,
    ) as string,
    path: applyRedaction(
      redact,
      artifact.path,
      resolvedSecretRefs,
    ) as string,
  };
}

function redactRunArtifactAudit(
  redact: RedactFn,
  artifact: Artifact,
  resolvedSecretRefs: ReadonlySet<string>,
): Artifact | undefined {
  const bytes = redactAuditNumber(
    redact,
    artifact.bytes,
    resolvedSecretRefs,
  );
  // ArtifactSchema requires a numeric byte count. If publishing that
  // observation would reveal a numeric secret, withhold this optional audit
  // row as a unit instead of corrupting the public RunRecord contract.
  if (bytes === undefined) return undefined;
  const audit = redactArtifactAudit(
    redact,
    artifact,
    resolvedSecretRefs,
  );
  return {
    id: artifact.id,
    runId: artifact.runId,
    ...(artifact.stepId !== undefined
      ? { stepId: artifact.stepId }
      : {}),
    ...audit,
    bytes,
    createdAt: artifact.createdAt,
  };
}

export function redactApprovalAudit(
  redact: RedactFn,
  task: ApprovalTask,
  resolvedSecretRefs: ReadonlySet<string>,
): ApprovalTask {
  redact = conservativePublicRedact(redact);
  return {
    ...task,
    title: applyRedaction(
      redact,
      task.title,
      resolvedSecretRefs,
    ),
    description: applyRedaction(
      redact,
      task.description,
      resolvedSecretRefs,
    ),
    ...(task.decision !== undefined
      ? {
          decision: applyRedaction(
            redact,
            task.decision,
            resolvedSecretRefs,
          ),
        }
      : {}),
    ...(task.reviewer !== undefined
      ? {
          reviewer: applyRedaction(
            redact,
            task.reviewer,
            resolvedSecretRefs,
          ) as string,
        }
      : {}),
    ...(task.authenticatedAs !== undefined
      ? {
          authenticatedAs: applyRedaction(
            redact,
            task.authenticatedAs,
            resolvedSecretRefs,
          ) as string,
        }
      : {}),
  };
}

export function redactWaitAudit(
  redact: RedactFn,
  wait: WaitCondition,
  resolvedSecretRefs: ReadonlySet<string>,
): WaitCondition {
  redact = conservativePublicRedact(redact);
  const value = (input: string): string =>
    applyRedaction(redact, input, resolvedSecretRefs) as string;
  const timeout = (input: { timeout?: string }): { timeout?: string } =>
    input.timeout === undefined
      ? {}
      : { timeout: value(input.timeout) };

  // Every union member is rebuilt from literal schema keys. Redacting the
  // object wholesale is unsafe when a secret literal equals "name",
  // "correlationId", or another required key: key-scanning redactors can
  // otherwise return a malformed public WaitCondition.
  switch (wait.type) {
    case "approval":
      return {
        type: wait.type,
        taskId: value(wait.taskId),
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    case "signal":
      return {
        type: wait.type,
        name: value(wait.name),
        correlationId: value(wait.correlationId),
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    case "timer":
      return {
        type: wait.type,
        resumeAt: value(wait.resumeAt),
        schemaVersion: wait.schemaVersion,
      };
    case "webhook":
      return {
        type: wait.type,
        event: value(wait.event),
        correlationId: value(wait.correlationId),
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    case "external_job":
      return {
        type: wait.type,
        provider: value(wait.provider),
        jobId: value(wait.jobId),
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    case "queue":
      return {
        type: wait.type,
        queue: value(wait.queue),
        correlationId: value(wait.correlationId),
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    case "manual":
      return {
        type: wait.type,
        ...timeout(wait),
        schemaVersion: wait.schemaVersion,
      };
    default: {
      const exhaustive: never = wait;
      return exhaustive;
    }
  }
}

export function redactSignalAudit(
  redact: RedactFn,
  signal: Pick<Signal, "name" | "correlationId" | "payload">,
  resolvedSecretRefs: ReadonlySet<string>,
): Pick<Signal, "name" | "correlationId" | "payload"> {
  redact = conservativePublicRedact(redact);
  // Rebuild from literal field names. A whole-object redactor may scan keys
  // as well as values; casting that result would leave required signal
  // fields missing and could preserve the original value in adapter spreads.
  return {
    name: applyRedaction(
      redact,
      signal.name,
      resolvedSecretRefs,
    ) as string,
    correlationId: applyRedaction(
      redact,
      signal.correlationId,
      resolvedSecretRefs,
    ) as string,
    payload: applyRedaction(
      redact,
      signal.payload,
      resolvedSecretRefs,
    ),
  };
}

interface CustomerVisibleAuditRepairOptions {
  runId?: string;
  includeRuns?: boolean;
  includeArtifacts?: boolean;
  includeUnattributedSignalAudits?: boolean;
}

/**
 * Literal-only security repair. This intentionally does not reconstruct
 * workflow provenance; callers use it for the cheap global pass and pair it
 * with graph-limited provenance repair where a cache lineage is affected.
 */
export async function repairCustomerVisibleAudits(
  store: AartStore,
  redact: RedactFn,
  resolvedSecretRefs: ReadonlySet<string>,
  options: CustomerVisibleAuditRepairOptions = {},
): Promise<void> {
  if (resolvedSecretRefs.size === 0) return;
  redact = conservativePublicRedact(redact);
  const runId = options.runId;
  const [
    runs,
    artifacts,
    approvals,
    waits,
    signals,
    unattributedSignals,
    corrections,
    events,
    evalSuites,
    evalExamples,
    evalRuns,
  ] = await Promise.all([
    options.includeRuns === false
      ? Promise.resolve([])
      : runId === undefined
        ? store.runs.list()
        : store.runs.get(runId).then((run) =>
            run === undefined ? [] : [run],
          ),
    options.includeArtifacts === false
      ? Promise.resolve([])
      : runId === undefined
        ? store.artifacts.listForRedaction()
        : store.artifacts.listForRedaction(runId),
    store.approvals.list(
      runId === undefined ? undefined : { runId },
    ),
    store.waits.list(
      runId === undefined ? undefined : { runId },
    ),
    runId === undefined
      ? store.signals.list()
      : store.signals.listConsumedByRun(runId),
    options.includeUnattributedSignalAudits
      ? store.signals.listConsumedWithoutProvenance()
      : Promise.resolve([]),
    store.corrections.list(
      runId === undefined ? undefined : { runId },
    ),
    store.events.list(
      runId === undefined ? undefined : { runId },
    ),
    store.evals.listSuites(),
    store.evals.listExamples(),
    store.evals.listRuns(),
  ]);

  for (const run of runs) {
    const repaired = applyRunRedaction(
      redact,
      run,
      resolvedSecretRefs,
    );
    const activeState =
      await store.runs.getOperationalState(run.runId);
    if (
      run.status === "pending" ||
      run.status === "running"
    ) {
      await store.runs.putOperationalState(run.runId, {
        run: mergeOperationalRunTaint(
          activeState?.run ?? run,
          repaired,
        ),
        resolvedSecretValues: [
          ...new Set([
            ...(activeState?.resolvedSecretValues ?? []),
            ...resolvedSecretRefs,
          ]),
        ],
        ...(activeState?.pendingIdempotencyReplays !== undefined
          ? {
              pendingIdempotencyReplays:
                activeState.pendingIdempotencyReplays,
            }
          : {}),
      });
    }
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      const exactState = activeState ?? {
        run,
        resolvedSecretValues: [],
      };
      const {
        pendingIdempotencyReplays: _pendingClaims,
        ...archiveBase
      } = exactState;
      await store.runs.putOperationalState(run.runId, {
        ...archiveBase,
        run: mergeOperationalRunTaint(
          exactState.run,
          repaired,
        ),
        resolvedSecretValues: [
          ...new Set([
            ...exactState.resolvedSecretValues,
            ...resolvedSecretRefs,
          ]),
        ],
      });
    }
    if (run.status === "waiting") {
      const outstanding = waits.filter(
        (entry) => entry.runId === run.runId,
      );
      const existingState =
        outstanding[0] === undefined
          ? undefined
          : await store.waits.getOperationalRunState(
              outstanding[0].runId,
              outstanding[0].stepId,
            );
      if (outstanding.length > 0) {
        await store.waits.replaceOperationalRunState(run.runId, {
          run: mergeOperationalRunTaint(
            existingState?.run ?? run,
            repaired,
          ),
          resolvedSecretValues: [
            ...new Set([
              ...(existingState?.resolvedSecretValues ?? []),
              ...resolvedSecretRefs,
            ]),
          ],
        });
      }
    }
    if (JSON.stringify(repaired) !== JSON.stringify(run)) {
      await store.runs.put(repaired);
    }
  }
  await redactStoredArtifacts(
    store,
    redact,
    artifacts,
    resolvedSecretRefs,
  );
  for (const task of approvals) {
    const repaired = redactApprovalAudit(
      redact,
      task,
      resolvedSecretRefs,
    );
    if (JSON.stringify(repaired) !== JSON.stringify(task)) {
      await store.approvals.put(redactApprovalAudit(redact, task, resolvedSecretRefs));
    }
  }
  for (const entry of waits) {
    const repaired = redactWaitAudit(
      redact,
      entry.wait,
      resolvedSecretRefs,
    );
    if (JSON.stringify(repaired) !== JSON.stringify(entry.wait)) {
      await store.waits.redactAudit(
        entry.runId,
        entry.stepId,
        repaired,
      );
    }
  }
  const signalsById = new Map(
    [...signals, ...unattributedSignals].map((signal) => [
      signal.id,
      signal,
    ]),
  );
  for (const signal of signalsById.values()) {
    const audit = redactSignalAudit(
      redact,
      signal,
      resolvedSecretRefs,
    );
    if (
      JSON.stringify(audit) !==
      JSON.stringify({
        name: signal.name,
        correlationId: signal.correlationId,
        payload: signal.payload,
      })
    ) {
      await store.signals.replaceAudit(
        signal.id,
        audit,
        [...resolvedSecretRefs],
      );
    }
  }
  const correctionKeyRewrites = new Map<string, string>();
  for (const correction of corrections) {
    const audit = {
      fieldPath: applyRedaction(
        redact,
        correction.fieldPath,
        resolvedSecretRefs,
      ) as string,
      observed: applyRedaction(
        redact,
        correction.observed,
        resolvedSecretRefs,
      ),
      corrected: applyRedaction(
        redact,
        correction.corrected,
        resolvedSecretRefs,
      ),
      reason: applyRedaction(
        redact,
        correction.reason,
        resolvedSecretRefs,
      ) as string,
      reviewer: applyRedaction(
        redact,
        correction.reviewer,
        resolvedSecretRefs,
      ) as string,
    };
    if (
      JSON.stringify(audit) !==
      JSON.stringify({
        fieldPath: correction.fieldPath,
        observed: correction.observed,
        corrected: correction.corrected,
        reason: correction.reason,
        reviewer: correction.reviewer,
      })
    ) {
      const replaced = await store.corrections.replaceAudit(
        correction,
        audit,
      );
      if (replaced !== undefined) {
        correctionKeyRewrites.set(
          correctionAuditKey(correction),
          correctionAuditKey(replaced),
        );
      }
    }
  }
  const evalExampleIdRewrites = new Map<string, string>();
  const repairedByOriginalId = new Map<
    string,
    EvalExample
  >();
  const repairEvalExample = async (
    example: EvalExample,
  ): Promise<EvalExample> => {
    const alreadyRepaired =
      repairedByOriginalId.get(example.id);
    if (alreadyRepaired !== undefined) {
      return alreadyRepaired;
    }
    if (
      runId !== undefined &&
      example.sourceRunId !== runId
    ) {
      return example;
    }
    const redactedId = applyRedaction(
      redact,
      example.id,
      resolvedSecretRefs,
    ) as string;
    const createdFromCorrection =
      example.createdFromCorrection === undefined
        ? undefined
        : correctionKeyRewrites.get(
            example.createdFromCorrection,
          ) ??
          (applyRedaction(
            redact,
            example.createdFromCorrection,
            resolvedSecretRefs,
          ) as string);
    const repairedExample: EvalExample = {
      ...example,
      id:
        redactedId === example.id
          ? example.id
          : `ex_redacted_${randomUUID()}`,
      input: applyRedaction(
        redact,
        example.input,
        resolvedSecretRefs,
      ),
      expected: applyRedaction(
        redact,
        example.expected,
        resolvedSecretRefs,
      ),
      ...(example.scorerConfig === undefined
        ? {}
        : {
            scorerConfig: applyRedaction(
              redact,
              example.scorerConfig,
              resolvedSecretRefs,
            ),
          }),
      ...(example.tags === undefined
        ? {}
        : {
            tags: applyRedaction(
              redact,
              example.tags,
              resolvedSecretRefs,
            ) as string[],
          }),
      ...(createdFromCorrection === undefined
        ? {}
        : { createdFromCorrection }),
    };
    if (
      JSON.stringify(repairedExample) !==
      JSON.stringify(example)
    ) {
      await store.evals.replaceExampleAudit(
        example.id,
        repairedExample,
      );
      repairedByOriginalId.set(
        example.id,
        repairedExample,
      );
      if (repairedExample.id !== example.id) {
        evalExampleIdRewrites.set(
          example.id,
          repairedExample.id,
        );
      }
    }
    return repairedExample;
  };
  for (const example of evalExamples) {
    await repairEvalExample(example);
  }
  for (const suite of evalSuites) {
    const repairedEmbedded = await Promise.all(
      suite.examples.map((example) =>
        repairEvalExample(example),
      ),
    );
    if (
      JSON.stringify(repairedEmbedded) !==
      JSON.stringify(suite.examples)
    ) {
      await store.evals.putSuite({
        ...suite,
        examples: repairedEmbedded,
      });
    }
  }
  for (const evalRun of evalRuns) {
    const regressions = evalRun.regressions.map(
      (id) =>
        evalExampleIdRewrites.get(id) ??
        (applyRedaction(
          redact,
          id,
          resolvedSecretRefs,
        ) as string),
    );
    const improvements = evalRun.improvements.map(
      (id) =>
        evalExampleIdRewrites.get(id) ??
        (applyRedaction(
          redact,
          id,
          resolvedSecretRefs,
        ) as string),
    );
    if (
      JSON.stringify(regressions) !==
        JSON.stringify(evalRun.regressions) ||
      JSON.stringify(improvements) !==
        JSON.stringify(evalRun.improvements)
    ) {
      await store.evals.putRun({
        ...evalRun,
        regressions,
        improvements,
      });
    }
  }
  for (const event of events) {
    const summary = applyRedaction(
      redact,
      event.summary,
      resolvedSecretRefs,
    ) as string;
    const actor =
      event.actor === undefined
        ? undefined
        : (applyRedaction(
            redact,
            event.actor,
            resolvedSecretRefs,
          ) as string);
    if (summary !== event.summary || actor !== event.actor) {
      await store.events.replaceAudit(event.id, {
        summary,
        ...(actor !== undefined ? { actor } : {}),
      });
    }
  }
}

const globallyRepairedSecretValues = new WeakMap<
  ReadonlySet<string>,
  Set<string>
>();

/**
 * Runs a state transition and every newly required public-audit repair in
 * one store transaction. The callback may discover additional secret
 * values; those receive a second repair pass before commit. The watermark
 * advances only after the complete transition succeeds.
 */
export async function transactWithGlobalSecretRepair<T>(
  store: AartStore,
  redact: RedactFn,
  resolvedSecretRefs: ReadonlySet<string>,
  transition: (transactionStore: AartStore) => Promise<T>,
): Promise<T> {
  const alreadyRepaired = new Set(
    globallyRepairedSecretValues.get(resolvedSecretRefs) ?? [],
  );
  const repairedByThisTransition = new Set(alreadyRepaired);
  const result = await store.transact(
    async (transactionStore) => {
      const repairNewValues = async (): Promise<void> => {
        const newlyResolved = [...resolvedSecretRefs].filter(
          (value) => !repairedByThisTransition.has(value),
        );
        if (newlyResolved.length === 0) return;
        await repairCustomerVisibleAudits(
          transactionStore,
          redact,
          resolvedSecretRefs,
        );
        for (const value of resolvedSecretRefs) {
          repairedByThisTransition.add(value);
        }
      };
      await repairNewValues();
      const transitioned = await transition(transactionStore);
      await repairNewValues();
      return transitioned;
    },
  );
  globallyRepairedSecretValues.set(
    resolvedSecretRefs,
    repairedByThisTransition,
  );
  return result;
}

/**
 * Standalone public-audit repair for callers that have no accompanying run
 * transition. Production lifecycle paths pair repair with cache revocation
 * through transactWithGlobalSecretRepair().
 */
export async function repairGlobalAuditsForNewSecrets(
  store: AartStore,
  redact: RedactFn,
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<void> {
  const alreadyRepaired =
    globallyRepairedSecretValues.get(resolvedSecretRefs);
  if (
    alreadyRepaired !== undefined &&
    [...resolvedSecretRefs].every((value) =>
      alreadyRepaired.has(value),
    )
  ) {
    return;
  }
  await transactWithGlobalSecretRepair(
    store,
    redact,
    resolvedSecretRefs,
    async () => undefined,
  );
}

function mergeTaintPaths(
  redact: RedactFn,
  existing: string[],
  discovered: string[],
  resolvedSecretRefs: ReadonlySet<string>,
  forceWildcard = false,
): string[] {
  const redactedExisting = applyRedaction(
    redact,
    existing,
    resolvedSecretRefs,
  );
  const redactedDiscovered = applyRedaction(
    redact,
    discovered,
    resolvedSecretRefs,
  );
  if (
    forceWildcard ||
    existing.includes("*") ||
    discovered.includes("*") ||
    changedJsonPointers(existing, redactedExisting).length > 0 ||
    changedJsonPointers(discovered, redactedDiscovered).length > 0
  ) {
    return ["*"];
  }
  return [...new Set([...existing, ...discovered])];
}

/**
 * Redacts a RunRecord while keeping its active concurrency lock usable.
 * A still-public authored key remains backward-readable until it becomes a
 * known secret; at that point it is replaced by the tagged fingerprint the
 * concurrency matcher already supports. Terminal records no longer
 * participate in matching and remain fully redacted.
 */
function redactAuditNumber(
  redact: RedactFn,
  value: number,
  resolvedSecretRefs: ReadonlySet<string>,
): number | undefined {
  const redacted = applyRedaction(
    redact,
    value,
    resolvedSecretRefs,
  );
  return typeof redacted === "number" &&
    Object.is(redacted, value)
    ? value
    : undefined;
}

export function applyRunRedaction(redact: RedactFn, run: RunRecord, resolvedSecretRefs: ReadonlySet<string>): RunRecord {
  redact = conservativePublicRedact(redact);
  const {
    trace: _trace,
    inputs: rawInputs,
    trigger: rawTrigger,
    secretTaintedInputPaths: existingInputPaths = [],
    secretTaintedTriggerPaths: existingTriggerPaths = [],
    ..._runWithoutTrace
  } = run;
  const inputs = applyRedaction(redact, rawInputs, resolvedSecretRefs);
  const trigger = {
    type: rawTrigger.type,
    id: rawTrigger.id,
    source: applyRedaction(
      redact,
      rawTrigger.source,
      resolvedSecretRefs,
    ),
    payload: applyRedaction(
      redact,
      rawTrigger.payload,
      resolvedSecretRefs,
    ),
    ...(rawTrigger.correlationId !== undefined
      ? {
          correlationId: applyRedaction(
            redact,
            rawTrigger.correlationId,
            resolvedSecretRefs,
          ),
        }
      : {}),
    receivedAt: rawTrigger.receivedAt,
    ...(rawTrigger.dedupeKey !== undefined
      ? {
          dedupeKey: applyRedaction(
            redact,
            rawTrigger.dedupeKey,
            resolvedSecretRefs,
          ),
        }
      : {}),
  } as typeof rawTrigger;
  const secretTaintedInputPaths = mergeTaintPaths(
    redact,
    existingInputPaths,
    changedJsonPointers(rawInputs, inputs),
    resolvedSecretRefs,
  );
  const secretTaintedTriggerPaths = mergeTaintPaths(
    redact,
    existingTriggerPaths,
    changedJsonPointers(rawTrigger, trigger),
    resolvedSecretRefs,
  );
  const activeRun =
    run.status === "pending" ||
    run.status === "running" ||
    run.status === "waiting";
  const params =
    run.params === undefined
      ? undefined
      : {
          ...(applyRedaction(
            redact,
            run.params,
            resolvedSecretRefs,
          ) as Record<string, unknown>),
          // These keys are execution control state, not workflow data.
          // Reclaiming a redacted running run must not turn dry-run off or
          // strand a queued run when
          // a resolved boolean/string happens to equal one of these values.
          // The exact capability environment remains only in sealed
          // operational state; restoring it here would publish a secret
          // whenever an environment name equals a resolved literal.
          ...(typeof run.params.dryRun === "boolean"
            ? { dryRun: run.params.dryRun }
            : {}),
          ...(typeof run.params.waitingOnConcurrency === "boolean"
            ? {
                waitingOnConcurrency:
                  run.params.waitingOnConcurrency,
              }
            : {}),
          ...(typeof run.params.concurrencyKeyFormat === "string"
            ? {
                concurrencyKeyFormat:
                  run.params.concurrencyKeyFormat,
              }
            : {}),
          ...(activeRun &&
          run.params.concurrencyKeyFormat ===
            CONCURRENCY_KEY_FORMAT &&
          typeof run.params.concurrencyKey === "string"
            ? { concurrencyKey: run.params.concurrencyKey }
            : {}),
          ...(activeRun &&
          run.params.concurrencyKeyFormat !==
            CONCURRENCY_KEY_FORMAT &&
          typeof run.params.concurrencyKey === "string"
            ? applyRedaction(
                redact,
                run.params.concurrencyKey,
                resolvedSecretRefs,
              ) === run.params.concurrencyKey
              ? { concurrencyKey: run.params.concurrencyKey }
              : {
                  concurrencyKey: fingerprintConcurrencyKey(
                    run.params.concurrencyKey,
                  ),
                  concurrencyKeyFormat: CONCURRENCY_KEY_FORMAT,
                }
            : {}),
        };
  const redactedTrace = run.trace.map((trace): StepTrace => {
    // Reconstruct from an explicit structural allowlist rather than
    // spreading the trace. Authored/runtime identity remains stable for
    // resume and expression addressing; every payload/observational field
    // is copied only after independent redaction, which also preserves the
    // StepTrace schema's field names when a secret happens to equal one.
    const redactedInputs = applyRedaction(
      redact,
      trace.inputs,
      resolvedSecretRefs,
    );
    const inputDiscoveredPaths = changedJsonPointers(
      trace.inputs,
      redactedInputs,
    );
    const redactedOutputs =
      trace.outputs === undefined
        ? undefined
        : applyRedaction(
            redact,
            trace.outputs,
            resolvedSecretRefs,
          );
    const discoveredPaths =
      trace.outputs === undefined || redactedOutputs === undefined
        ? []
        : changedJsonPointers(trace.outputs, redactedOutputs);
    const existingPaths =
      trace.secretTaintedPaths ??
      (trace.secretTainted === true ? ["*"] : []);
    const secretTaintedPaths = mergeTaintPaths(
      redact,
      existingPaths,
      discoveredPaths,
      resolvedSecretRefs,
      inputDiscoveredPaths.length > 0 && trace.outputs !== undefined,
    );
    const durationMs =
      trace.durationMs === undefined
        ? undefined
        : redactAuditNumber(
            redact,
            trace.durationMs,
            resolvedSecretRefs,
          );
    const llmCall =
      trace.llmCall === undefined
        ? undefined
        : (() => {
            const tokensIn = redactAuditNumber(
              redact,
              trace.llmCall.tokensIn,
              resolvedSecretRefs,
            );
            const tokensOut = redactAuditNumber(
              redact,
              trace.llmCall.tokensOut,
              resolvedSecretRefs,
            );
            const latencyMs = redactAuditNumber(
              redact,
              trace.llmCall.latencyMs,
              resolvedSecretRefs,
            );
            // Required numeric metrics cannot carry a string redaction
            // marker without corrupting the schema. Withhold the optional
            // llmCall audit as a unit if any required metric is secret.
            if (
              tokensIn === undefined ||
              tokensOut === undefined ||
              latencyMs === undefined
            ) {
              return undefined;
            }
            const costEstimate =
              trace.llmCall.costEstimate === undefined
                ? undefined
                : redactAuditNumber(
                    redact,
                    trace.llmCall.costEstimate,
                    resolvedSecretRefs,
                  );
            return {
              provider: applyRedaction(
                redact,
                trace.llmCall.provider,
                resolvedSecretRefs,
              ),
              model: applyRedaction(
                redact,
                trace.llmCall.model,
                resolvedSecretRefs,
              ),
              promptRef: applyRedaction(
                redact,
                trace.llmCall.promptRef,
                resolvedSecretRefs,
              ),
              promptVersion: applyRedaction(
                redact,
                trace.llmCall.promptVersion,
                resolvedSecretRefs,
              ),
              ...(trace.llmCall.schemaRef !== undefined
                ? {
                    schemaRef: applyRedaction(
                      redact,
                      trace.llmCall.schemaRef,
                      resolvedSecretRefs,
                    ),
                  }
                : {}),
              tokensIn,
              tokensOut,
              latencyMs,
              ...(costEstimate !== undefined
                ? { costEstimate }
                : {}),
              ...(trace.llmCall.scorerResult !== undefined
                ? {
                    scorerResult: applyRedaction(
                      redact,
                      trace.llmCall.scorerResult,
                      resolvedSecretRefs,
                    ),
                  }
                : {}),
            };
          })();
    const externalCalls =
      trace.externalCalls?.flatMap((call) => {
        const durationMs = redactAuditNumber(
          redact,
          call.durationMs,
          resolvedSecretRefs,
        );
        if (durationMs === undefined) return [];
        const status =
          call.status === undefined
            ? undefined
            : redactAuditNumber(
                redact,
                call.status,
                resolvedSecretRefs,
              );
        return [{
          system: applyRedaction(
            redact,
            call.system,
            resolvedSecretRefs,
          ),
          domain: applyRedaction(
            redact,
            call.domain,
            resolvedSecretRefs,
          ),
          ...(call.method !== undefined
            ? {
                method: applyRedaction(
                  redact,
                  call.method,
                  resolvedSecretRefs,
                ),
              }
            : {}),
          ...(status !== undefined ? { status } : {}),
          durationMs,
        }];
      });
    return {
      seq: trace.seq,
      stepId: trace.stepId,
      block: trace.block,
      status: trace.status,
      inputs: redactedInputs,
      startedAt: trace.startedAt,
      ...(trace.endedAt !== undefined ? { endedAt: trace.endedAt } : {}),
      ...(durationMs !== undefined
        ? { durationMs }
        : {}),
      ...(trace.postHocCorrected !== undefined
        ? { postHocCorrected: trace.postHocCorrected }
        : {}),
      ...(trace.authoredStepId !== undefined
        ? { authoredStepId: trace.authoredStepId }
        : {}),
      ...(trace.iterationIndex !== undefined
        ? { iterationIndex: trace.iterationIndex }
        : {}),
      ...(redactedOutputs !== undefined ? { outputs: redactedOutputs } : {}),
      ...(trace.error !== undefined
        ? {
            error: applyRedaction(
              redact,
              trace.error,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(trace.artifacts !== undefined
        ? {
            artifacts: trace.artifacts.flatMap((artifact) => {
              const audit = redactRunArtifactAudit(
                redact,
                artifact,
                resolvedSecretRefs,
              );
              return audit === undefined ? [] : [audit];
            }),
          }
        : {}),
      ...(llmCall !== undefined
        ? { llmCall }
        : {}),
      ...(externalCalls !== undefined
        ? { externalCalls }
        : {}),
      ...(trace.idempotencyLedgerKey !== undefined
        ? {
            idempotencyLedgerKey: applyRedaction(
              redact,
              trace.idempotencyLedgerKey,
              resolvedSecretRefs,
            ),
          }
        : {}),
      ...(trace.idempotencyLedgerFingerprint !== undefined ||
      trace.idempotencyLedgerKey !== undefined
        ? {
            idempotencyLedgerFingerprint:
              trace.idempotencyLedgerFingerprint ??
              idempotencyAssociationFingerprint(
                trace.idempotencyLedgerKey!,
              ),
          }
        : {}),
      ...(secretTaintedPaths.length > 0 ||
      trace.secretTainted === true ||
      trace.controlSecretTainted === true
        ? { secretTainted: true, secretTaintedPaths }
        : {}),
      ...(trace.controlSecretTainted === true
        ? { controlSecretTainted: true }
        : {}),
    };
  });
  const snapshotDefinitions = applyRedaction(
    redact,
    run.snapshot.definitions,
    resolvedSecretRefs,
  );
  const snapshot = {
    // A partially rewritten workflow is not executable and can mislead an
    // audit reader. Withhold the public definition tree if any literal was
    // removed; the exact copy lives only in the sealed wait continuation.
    definitions:
      jsonValuesEqual(
        snapshotDefinitions,
        run.snapshot.definitions,
      )
        ? run.snapshot.definitions
        : null,
    resolvedVersions: applyRedaction(
      redact,
      run.snapshot.resolvedVersions,
      resolvedSecretRefs,
    ),
    packHashes: applyRedaction(
      redact,
      run.snapshot.packHashes,
      resolvedSecretRefs,
    ),
    capturedAt: run.snapshot.capturedAt,
  };
  const artifacts = run.artifacts.flatMap((artifact) => {
    const audit = redactRunArtifactAudit(
      redact,
      artifact,
      resolvedSecretRefs,
    );
    return audit === undefined ? [] : [audit];
  });
  const flag =
    run.flag === undefined || run.flag === null
      ? run.flag
      : {
          kind: run.flag.kind,
          flaggedAt: run.flag.flaggedAt,
          ...(run.flag.clearedBy !== undefined
            ? {
                clearedBy: applyRedaction(
                  redact,
                  run.flag.clearedBy,
                  resolvedSecretRefs,
                ),
              }
            : {}),
          ...(run.flag.clearedAt !== undefined
            ? { clearedAt: run.flag.clearedAt }
            : {}),
        };
  const redacted: RunRecord = {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    status: run.status,
    approved: run.approved,
    approvalMode: run.approvalMode,
    inputs,
    trigger,
    ...(params !== undefined ? { params } : {}),
    trace: redactedTrace,
    waits: run.waits.map((wait) =>
      redactWaitAudit(redact, wait, resolvedSecretRefs),
    ),
    ...(run.outputs !== undefined
      ? {
          outputs: applyRedaction(
            redact,
            run.outputs,
            resolvedSecretRefs,
          ),
        }
      : {}),
    ...(run.error !== undefined
      ? {
          error: applyRedaction(
            redact,
            run.error,
            resolvedSecretRefs,
          ),
        }
      : {}),
    artifacts,
    snapshot,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt !== undefined
      ? { endedAt: run.endedAt }
      : {}),
    ...(flag !== undefined ? { flag } : {}),
    schemaVersion: run.schemaVersion,
    ...(secretTaintedInputPaths.length > 0
      ? { secretTaintedInputPaths }
      : {}),
    ...(secretTaintedTriggerPaths.length > 0
      ? { secretTaintedTriggerPaths }
      : {}),
  };
  return redacted;
}

function mergeStringSets(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])];
  return merged.length === 0 ? undefined : merged;
}

/**
 * Carries newly discovered provenance into the protected raw continuation
 * without replacing its executable payloads with public redaction markers.
 */
export function mergeOperationalRunTaint(
  operational: RunRecord,
  repairedAudit: RunRecord,
): RunRecord {
  const auditTraceBySeq = new Map(
    repairedAudit.trace.map((trace) => [trace.seq, trace]),
  );
  return {
    ...operational,
    secretTaintedInputPaths: mergeStringSets(
      operational.secretTaintedInputPaths,
      repairedAudit.secretTaintedInputPaths,
    ),
    secretTaintedTriggerPaths: mergeStringSets(
      operational.secretTaintedTriggerPaths,
      repairedAudit.secretTaintedTriggerPaths,
    ),
    trace: operational.trace.map((trace) => {
      const audit = auditTraceBySeq.get(trace.seq);
      if (!audit) return trace;
      const secretTaintedPaths = mergeStringSets(
        trace.secretTaintedPaths,
        audit.secretTaintedPaths,
      );
      return {
        ...trace,
        ...(trace.secretTainted === true ||
        audit.secretTainted === true
          ? { secretTainted: true }
          : {}),
        ...(secretTaintedPaths !== undefined
          ? { secretTaintedPaths }
          : {}),
        ...(trace.controlSecretTainted === true ||
        audit.controlSecretTainted === true
          ? { controlSecretTainted: true }
          : {}),
        ...(audit.idempotencyLedgerFingerprint !== undefined
          ? {
              idempotencyLedgerFingerprint:
                audit.idempotencyLedgerFingerprint,
            }
          : {}),
      };
    }),
  };
}

/**
 * Rejoins security provenance that another execution segment may have
 * discovered while this worker was between durable writes. The caller's
 * RunRecord remains the forward-progress source; only protected taint and
 * newly known secret literals are imported.
 */
export async function mergeActiveRunProtection(
  store: AartStore,
  run: RunRecord,
  resolvedSecretRefs: Set<string>,
): Promise<RunRecord> {
  const activeState =
    await store.runs.getOperationalState(run.runId);
  if (activeState === undefined) return run;
  for (const value of activeState.resolvedSecretValues) {
    resolvedSecretRefs.add(value);
  }
  const protectedRun = mergeOperationalRunTaint(
    run,
    activeState.run,
  );
  const taintedPendingClaims =
    activeState.pendingIdempotencyReplays?.filter(
      (claim) => claim.outputSecretTainted === true,
    ) ?? [];
  if (taintedPendingClaims.length === 0) {
    return protectedRun;
  }
  return {
    ...protectedRun,
    trace: protectedRun.trace.map((trace) =>
      taintedPendingClaims.some(
        (claim) =>
          claim.traceSeq === trace.seq &&
          claim.stepId === trace.stepId,
      )
        ? {
            ...trace,
            secretTainted: true,
            secretTaintedPaths: ["*"],
          }
        : trace,
    ),
  };
}

/**
 * Merges only security provenance from the latest public audit into a raw
 * in-memory run immediately before a whole-record write. Filesystem
 * transactions are serialized, but a step can prepare its next trace before
 * it acquires that lock; this prevents a repair that committed in between
 * from being overwritten by the prepared value.
 */
export async function mergePersistedRunTaint(
  store: AartStore,
  operational: RunRecord,
): Promise<RunRecord> {
  const persisted = await store.runs.get(operational.runId);
  return persisted === undefined
    ? operational
    : mergeOperationalRunTaint(operational, persisted);
}
