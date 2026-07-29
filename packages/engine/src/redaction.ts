// Redaction routing (architecture §4.2/§4.4 step 3/§4.6/§7.9, F2 chokepoint
// fix) — the engine routes EVERY StepTrace/RunRecord/wait-checkpoint persist
// through the constructor-injected `RedactFn`, threading in the claimed
// run's currently-resolved secret-refs set fresh on every call. This module
// is the one place that threading happens; every persist call site in this
// package goes through `applyRedaction`, never `config.redact` directly.
import type { SecretResolver } from "@aart/expr";
import type { AartStore } from "@aart/store";
import type {
  ApprovalTask,
  Artifact,
  RedactFn,
  RunRecord,
  Signal,
  StepTrace,
  WaitCondition,
} from "@aart/types";
import { SecretResolutionError } from "@aart/types";
import { idempotencyAssociationFingerprint } from "./idempotency-association.js";
import { jsonValuesEqual } from "./output-validation.js";

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
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
  const artifacts = await store.artifacts.listByRun(runId);
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
  artifacts: Artifact[],
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<Artifact[]> {
  if (resolvedSecretRefs.size === 0) return artifacts;

  const refreshed: Artifact[] = [];
  for (const artifact of artifacts) {
    const audit = applyRedaction(
      redact,
      {
        name: artifact.name,
        kind: artifact.kind,
        mime: artifact.mime,
        path: artifact.path,
      },
      resolvedSecretRefs,
    ) as Pick<Artifact, "name" | "kind" | "mime" | "path">;
    let redactedBytes: Uint8Array | undefined;
    if (await store.artifacts.isTextEligible(artifact.id)) {
      const bytes = await store.artifacts.getBytes(artifact.id);
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
    if (!auditChanged && redactedBytes === undefined) {
      refreshed.push(artifact);
      continue;
    }
    const updated = await store.artifacts.replaceAudit(
      artifact.id,
      audit,
      redactedBytes,
    );
    refreshed.push(updated ?? artifact);
  }
  return refreshed;
}

export function redactApprovalAudit(
  redact: RedactFn,
  task: ApprovalTask,
  resolvedSecretRefs: ReadonlySet<string>,
): ApprovalTask {
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
  const redacted = applyRedaction(
    redact,
    wait,
    resolvedSecretRefs,
  ) as WaitCondition;
  return {
    ...redacted,
    type: wait.type,
    schemaVersion: wait.schemaVersion,
  } as WaitCondition;
}

export function redactSignalAudit(
  redact: RedactFn,
  signal: Pick<Signal, "name" | "correlationId" | "payload">,
  resolvedSecretRefs: ReadonlySet<string>,
): Pick<Signal, "name" | "correlationId" | "payload"> {
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
        ? store.artifacts.list()
        : store.artifacts.listByRun(runId),
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
  ]);

  for (const run of runs) {
    const repaired = applyRunRedaction(
      redact,
      run,
      resolvedSecretRefs,
    );
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
      await store.corrections.replaceAudit(
        correction,
        audit,
      );
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
 * Runs one cheap global literal scan per newly resolved value in an
 * execution segment. This must be called outside another store transaction:
 * its successful transaction is the durable boundary that lets the
 * in-memory watermark advance without a later run-write rollback undoing
 * the audit repair.
 */
export async function repairGlobalAuditsForNewSecrets(
  store: AartStore,
  redact: RedactFn,
  resolvedSecretRefs: ReadonlySet<string>,
): Promise<void> {
  const alreadyRepaired =
    globallyRepairedSecretValues.get(resolvedSecretRefs) ??
    new Set<string>();
  const newlyResolved = new Set(
    [...resolvedSecretRefs].filter(
      (value) => !alreadyRepaired.has(value),
    ),
  );
  if (newlyResolved.size === 0) return;
  await store.transact((transactionStore) =>
    repairCustomerVisibleAudits(
      transactionStore,
      redact,
      newlyResolved,
    ),
  );
  for (const value of newlyResolved) {
    alreadyRepaired.add(value);
  }
  globallyRepairedSecretValues.set(
    resolvedSecretRefs,
    alreadyRepaired,
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
 * Redacts a RunRecord while keeping its active concurrency lock readable by
 * every intake version sharing the store. The authored key is operational
 * coordination state while a run is pending/running/waiting; changing it
 * mid-run can admit overlapping execution or strand a queued run. Terminal
 * records no longer participate in matching and remain fully redacted.
 */
export function applyRunRedaction(redact: RedactFn, run: RunRecord, resolvedSecretRefs: ReadonlySet<string>): RunRecord {
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
          // Reclaiming a redacted running run must not turn dry-run off,
          // lose its capability environment, or strand a queued run when
          // a resolved boolean/string happens to equal one of these values.
          ...(typeof run.params.dryRun === "boolean"
            ? { dryRun: run.params.dryRun }
            : {}),
          ...(typeof run.params.environment === "string"
            ? { environment: run.params.environment }
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
    return {
      seq: trace.seq,
      stepId: trace.stepId,
      block: trace.block,
      status: trace.status,
      inputs: redactedInputs,
      startedAt: trace.startedAt,
      ...(trace.endedAt !== undefined ? { endedAt: trace.endedAt } : {}),
      ...(trace.durationMs !== undefined
        ? { durationMs: trace.durationMs }
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
            artifacts: trace.artifacts.map((artifact) => {
              const audit = applyRedaction(
                redact,
                {
                  name: artifact.name,
                  kind: artifact.kind,
                  mime: artifact.mime,
                  path: artifact.path,
                },
                resolvedSecretRefs,
              );
              return {
                id: artifact.id,
                runId: artifact.runId,
                ...(artifact.stepId !== undefined
                  ? { stepId: artifact.stepId }
                  : {}),
                ...audit,
                bytes: artifact.bytes,
                createdAt: artifact.createdAt,
              };
            }),
          }
        : {}),
      ...(trace.llmCall !== undefined
        ? {
            llmCall: {
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
              tokensIn: trace.llmCall.tokensIn,
              tokensOut: trace.llmCall.tokensOut,
              latencyMs: trace.llmCall.latencyMs,
              ...(trace.llmCall.costEstimate !== undefined
                ? { costEstimate: trace.llmCall.costEstimate }
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
            },
          }
        : {}),
      ...(trace.externalCalls !== undefined
        ? {
            externalCalls: trace.externalCalls.map((call) => ({
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
              ...(call.status !== undefined
                ? { status: call.status }
                : {}),
              durationMs: call.durationMs,
            })),
          }
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
  const artifacts = run.artifacts.map((artifact) => {
    const audit = applyRedaction(
      redact,
      {
        name: artifact.name,
        kind: artifact.kind,
        mime: artifact.mime,
        path: artifact.path,
      },
      resolvedSecretRefs,
    );
    return {
      id: artifact.id,
      runId: artifact.runId,
      ...(artifact.stepId !== undefined
        ? { stepId: artifact.stepId }
        : {}),
      ...audit,
      bytes: artifact.bytes,
      createdAt: artifact.createdAt,
    };
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
  const concurrencyKey = run.params?.concurrencyKey;
  if (
    typeof concurrencyKey !== "string" ||
    (run.status !== "pending" && run.status !== "running" && run.status !== "waiting")
  ) {
    return redacted;
  }

  return {
    ...redacted,
    params: {
      ...redacted.params,
      concurrencyKey,
      ...(run.params?.concurrencyKeyFormat !== undefined
        ? { concurrencyKeyFormat: run.params.concurrencyKeyFormat }
        : {}),
    },
  };
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
