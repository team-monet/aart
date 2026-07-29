// Step execution (architecture §4.2) — the full per-step dispatch pipeline:
// resolve with -> check if -> capability check -> forEach -> dispatch ->
// retry/timeout -> idempotency -> redact -> record StepTrace -> determine
// next. Wait-type block ids (wait/wait-blocks.ts) are intercepted before
// normal dispatch and handed to wait/wait-machine.ts instead.
import { findExpressionTokens, parseExpression, type ExprContext, type ResolveOptions } from "@aart/expr";
import type { ApprovalTask, LlmCallMetadata, RetryPolicy, RunRecord, StepTrace, WaitCondition, Workflow, WorkflowStep } from "@aart/types";
import { AartError, DEFAULT_EFFECTFUL_CAPABILITIES, isEffectfulCapability, IterationLimitExceededError, TimeoutError } from "@aart/types";
import { checkCapabilityDispatch, alwaysEmptyGrantedCapabilities } from "./capability.js";
import { parseDurationMs } from "./duration.js";
import { buildExprContext, resolveArrayExpression, resolveBooleanExpression, resolveStringExpression, resolveWithRecord } from "./expr-context.js";
import { checkIdempotency, recordIdempotency } from "./idempotency.js";
import { jsonCompatibilityProblem, jsonValuesEqual } from "./output-validation.js";
import { applyRedaction, applyRunRedaction, changedJsonPointers, createTrackingSecretResolver, isTextMime, throwingSecretResolver } from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "./schema-version.js";
import type { EngineBlockExecutionContext, EngineConfig } from "./types.js";
import { enterWait, type WaitMachineConfig } from "./wait/wait-machine.js";
import { buildWaitConditionFromBlock, isWaitBlockId, type WaitBlockId } from "./wait/wait-blocks.js";

export type StepOutcome =
  | { kind: "continue"; run: RunRecord; nextStepId: string | undefined }
  | { kind: "waiting"; run: RunRecord }
  | { kind: "failed"; run: RunRecord; error: Error };

const DEFAULT_FOR_EACH_LIMIT = 10_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 50;

function nextStepIdInArrayOrder(workflow: Workflow, currentStepId: string): string | undefined {
  const index = workflow.execution.steps.findIndex((s) => s.id === currentStepId);
  if (index === -1) return undefined;
  return workflow.execution.steps[index + 1]?.id;
}

/** How many times `stepId` already appears in `run.trace` — the guarded-back-edge `maxIterations` counter (architecture §4.2/spec §18.2), derived from persisted trace history rather than separate in-memory bookkeeping, so it's correct across a restart mid-loop (a resumed run reloads its trace from the store, so this count is automatically right). */
function countPriorExecutions(run: RunRecord, stepId: string): number {
  return run.trace.filter((t) => t.stepId === stepId).length;
}

function classifyErrorClass(error: unknown): string {
  if (error instanceof AartError) return error.errorClass;
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") {
      if (status >= 500) return "HttpServerError";
      if (status >= 400 && status < 500) return "HttpClientError";
    }
  }
  return "UnknownError";
}

/** `RetryPolicy.retryOn` entries (spec §30.3's example: `["timeout", "5xx"]`) are short vocabulary tokens, not raw `errorClass` names — architecture micro-decision #9: "the engine's retry check is `errorClass ∈ retryOn` after normalizing both sides through the same taxonomy." Also accepts a bare `errorClass` name directly (e.g. `"TimeoutError"`), so an author who writes the precise class name isn't rejected either. */
const RETRY_TOKEN_TO_ERROR_CLASS: Record<string, string> = {
  timeout: "TimeoutError",
  "5xx": "HttpServerError",
  "4xx": "HttpClientError",
};

function retryTokenMatchesErrorClass(token: string, errorClass: string): boolean {
  return (RETRY_TOKEN_TO_ERROR_CLASS[token] ?? token) === errorClass;
}

function defaultComputeRetryDelayMs(attempt: number, backoff: string | undefined): number {
  if (backoff === "exponential") {
    return DEFAULT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `[DECISION]` per-attempt timeout via `Promise.race` (architecture micro-decision #10: "timeout applies per-attempt... a fresh timeout budget"). Note this is best-effort cancellation, a real JS/Node constraint: the underlying `execute()` call is not forcibly aborted when it loses the race (no ambient `AbortSignal` in the frozen `BlockExecutionContext`, architecture §2.5) — a block that ignores its own long-running work will keep running in the background even after this function has moved on. The one block type this engine itself builds (the isolated-vm sandbox, sandbox/node-sandbox.ts) DOES get true cancellation, since isolated-vm's own `timeout` option genuinely terminates isolate execution. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, context: { stepId: string }): Promise<T> {
  if (timeoutMs === undefined) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError({ message: `Step "${context.stepId}" exceeded its ${timeoutMs}ms timeout.`, detail: { kind: "step", stepId: context.stepId, timeoutMs } }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

interface RetryOutcome {
  output?: unknown;
  error?: Error;
  attempts: number;
}

async function dispatchWithRetry(
  execute: () => Promise<unknown>,
  retry: RetryPolicy | undefined,
  timeoutMs: number | undefined,
  computeDelay: (attempt: number, backoff: string | undefined) => number,
  context: { stepId: string },
): Promise<RetryOutcome> {
  const maxAttempts = Math.max(1, retry?.maxAttempts ?? 1);
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const output = await withTimeout(execute(), timeoutMs, context);
      return { output, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const errorClass = classifyErrorClass(lastError);
      const canRetry = attempt < maxAttempts && retry !== undefined && retry.retryOn.some((token) => retryTokenMatchesErrorClass(token, errorClass));
      if (!canRetry) {
        return { error: lastError, attempts: attempt };
      }
      const delay = computeDelay(attempt, retry.backoff);
      if (delay > 0) await sleep(delay);
    }
  }
  return { error: lastError, attempts: maxAttempts };
}

/**
 * F5 fix (root AMENDMENTS.md, S10 completion — was: "artifact bytes bypass
 * the redaction chokepoint"). `ctx.writeArtifact` used to call
 * `store.artifacts.put` directly with the block's raw bytes — the ONE
 * persist path in this package that never routed through `applyRedaction`
 * at all, RunRecord/StepTrace/wait-checkpoint persistence all covered, this
 * one entirely uncovered.
 *
 * Fix shape follows this codebase's own established "can't redact pixels"
 * posture (see `packages/blocks-core/src/browser/screenshot.ts`'s
 * `maskSelectors` comment: "text-based redaction doesn't work on a
 * bitmap") one step further, generalized from screenshots to every
 * artifact:
 *
 *   - TEXT-typed artifacts (`isTextMime` — text/*, application/json,
 *     +json, application/xml, +xml) decode as UTF-8, pass through the SAME
 *     `config.redact`/`resolvedSecretRefs` chokepoint every other persist
 *     call site in this package uses (`applyRedaction`), and re-encode.
 *     This is real value-scan-and-replace over real text, no different in
 *     kind from redacting a StepTrace output string.
 *   - BINARY artifacts (everything else — screenshots, downloads, PDFs,
 *     ...) are NOT scan-redacted. There is no text to scan-and-replace in
 *     a bitmap or an arbitrary binary blob; attempting to would either do
 *     nothing (the secret's bytes are encoded/compressed/rendered, not
 *     present as a literal substring) or corrupt the artifact outright.
 *     The control for binary artifact content is NOT "redact on write" —
 *     it's (a) PREVENTION at the point of capture, where that's possible
 *     (e.g. `browser.screenshot`'s `maskSelectors`, which blacks out a
 *     region BEFORE the bitmap is ever created), and (b) the fact that
 *     nothing in this system ever reads artifact bytes back into a lower-
 *     trust surface automatically — every report/MCP-tool-result/log this
 *     codebase builds references an artifact by its METADATA (id, path,
 *     kind, mime, byte count — see `@aart/evidence`'s report-model.ts) and
 *     NEVER inlines raw bytes; `ArtifactStore.getBytes` is called from
 *     nowhere in this repo's production code today (verified directly —
 *     only test code calls it). Reading a binary artifact's actual content
 *     back is necessarily a deliberate, separate, explicit act, not
 *     something that happens as a side effect of a run being reported on
 *     or an MCP tool returning. THIS is "the sensitive-read suppression
 *     mechanism" being the control instead of scan-redaction: nothing
 *     automatically SURFACES the bytes, so there is nothing for a passive
 *     reader to be exposed to.
 *
 * `onRecordLlmCall`, if given, is called synchronously whenever the
 * dispatched block invokes `ctx.recordLlmCall?.(metadata)` (S9 integration,
 * reconciliation ledger item 6, SEAMS.md L3 — `@aart/llm`'s `llm.*` blocks'
 * proposed extension point, now actually wired). `dispatchOnce` passes a
 * closure that captures the metadata into a local variable it attaches to
 * the step's `StepTrace` after dispatch completes.
 */
function buildBlockContext(
  config: EngineConfig,
  runId: string,
  stepId: string,
  secretResolver: ReturnType<typeof createTrackingSecretResolver>,
  resolvedSecretRefs: ReadonlySet<string>,
  onRecordLlmCall: (metadata: LlmCallMetadata) => void,
  onSecretAccess: (usage: "data" | "credential") => void,
): EngineBlockExecutionContext {
  return {
    runId,
    stepId,
    resolveSecret: async (ref: string, options) => {
      onSecretAccess(options?.usage ?? "data");
      const value = await secretResolver(ref);
      return typeof value === "string" ? value : String(value);
    },
    writeArtifact: async (input) => {
      const id = crypto.randomUUID();
      const path = `artifacts/${runId}/${id}`;
      // See this function's own doc comment (F5 fix) for the full text-vs
      // -binary rationale. Redaction runs on the LIVE resolvedSecretRefs
      // set at the moment writeArtifact is actually called, same as every
      // other persist call site — a block that resolves a secret and THEN
      // writes an artifact within the same execute() call is covered, not
      // just secrets resolved before dispatch began.
      const bytes = isTextMime(input.mime)
        ? new TextEncoder().encode(applyRedaction(config.redact, new TextDecoder().decode(input.bytes), resolvedSecretRefs))
        : input.bytes;
      await config.store.artifacts.put(
        { id, runId, stepId, name: input.name, kind: input.kind, mime: input.mime, path, bytes: bytes.byteLength, createdAt: (config.now?.() ?? new Date()).toISOString() },
        bytes,
      );
      return { id, path };
    },
    recordLlmCall: onRecordLlmCall,
  };
}

/** One block invocation — used both for a normal (non-forEach) step and for each individual forEach iteration. Handles idempotency short-circuit, retry/timeout, and returns a fully-formed `StepTrace` (never throws for an ordinary block failure — a failure is encoded as `status: "failed"`; only a truly unexpected condition, like a missing block registration, throws). */
async function dispatchOnce(
  config: EngineConfig,
  run: RunRecord,
  step: WorkflowStep,
  stepIdForTrace: string,
  seq: number,
  resolvedInputs: Record<string, unknown>,
  exprContext: ExprContext,
  resolveOptions: ResolveOptions,
  resolvedSecretRefs: Set<string>,
  dataSecretTaintedBeforeDispatch = false,
): Promise<StepTrace> {
  const impl = config.resolveBlockForRun?.(run, step.uses) ?? config.blocks[step.uses];
  if (!impl) {
    throw new Error(`No BlockImplementation registered for block id "${step.uses}" (step "${step.id}") — register it on EngineConfig.blocks before dispatch.`);
  }
  const now = () => config.now?.() ?? new Date();
  const startedAt = now().toISOString();

  const resolvedIdempotencyKey = await resolveStringExpression(step.idempotencyKey, exprContext, resolveOptions);
  if (
    resolvedIdempotencyKey !== undefined &&
    !dataSecretTaintedBeforeDispatch
  ) {
    const check = await checkIdempotency(config.store, resolvedIdempotencyKey);
    if (check.alreadyCompleted) {
      const endedAt = now().toISOString();
      const outputs = check.recordedOutput as Record<string, unknown>;
      const compatibilityProblem = jsonCompatibilityProblem(outputs, `step "${stepIdForTrace}" outputs`);
      if (compatibilityProblem) {
        return { seq, stepId: stepIdForTrace, authoredStepId: step.id, block: step.uses, status: "failed", inputs: resolvedInputs, error: compatibilityProblem, startedAt, endedAt, durationMs: 0 };
      }
      return { seq, stepId: stepIdForTrace, authoredStepId: step.id, block: step.uses, status: "completed", inputs: resolvedInputs, outputs, startedAt, endedAt, durationMs: 0 };
    }
  }

  const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
  // S9 integration (reconciliation ledger item 6): captures ctx.recordLlmCall's
  // argument, if the dispatched block calls it (e.g. @aart/llm's llm.*
  // blocks) — attached to the trace entry below once dispatch completes.
  // A non-llm block simply never calls it, leaving this undefined.
  let capturedLlmCall: LlmCallMetadata | undefined;
  let dataSecretAccessed = false;
  const ctx = buildBlockContext(config, run.runId, stepIdForTrace, secretResolver, resolvedSecretRefs, (metadata) => {
    capturedLlmCall = metadata;
  }, (usage) => {
    if (usage === "data") dataSecretAccessed = true;
  });
  const timeoutMs = step.timeout ? parseDurationMs(step.timeout) : undefined;
  const computeDelay = config.computeRetryDelayMs ?? defaultComputeRetryDelayMs;

  // Dry-run mode (S9 integration, reconciliation ledger item 7; architecture
  // §9.5 point 1): a run-level RunRecord.params.dryRun flag, checked here at
  // the dispatch boundary against the block's declared capabilities. An
  // effectful block's REAL handler is swapped for a recording stub that
  // logs "would have called X with args Y" and returns a synthetic success,
  // without making the real call — architecture §9.5's literal semantics.
  // Non-effectful blocks (most of the catalog) are entirely unaffected by
  // dryRun, even inside a dry-run — only the capability-gated subset fakes.
  const isDryRun = run.params?.["dryRun"] === true;
  const effectfulCapabilities = config.effectfulCapabilities ?? DEFAULT_EFFECTFUL_CAPABILITIES;
  const shouldFake = isDryRun && impl.manifest.capabilities.some((c) => isEffectfulCapability(c, effectfulCapabilities));
  const dispatch = shouldFake
    ? async (): Promise<unknown> => ({ dryRun: true, wouldHaveCalled: step.uses, args: resolvedInputs })
    : (): Promise<unknown> => impl.execute(resolvedInputs, ctx);

  const { output, error } = await dispatchWithRetry(dispatch, step.retry, timeoutMs, computeDelay, { stepId: stepIdForTrace });
  const endedAt = now().toISOString();
  const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());

  if (error) {
    // llmCall metadata is only ever built by @aart/llm's blocks AFTER a
    // successful call+validate (core.ts's llmCall/llmExtract/etc.) — a
    // thrown error means recordLlmCall was never reached, so there's
    // nothing to attach here even on a genuinely-failed LLM call.
    return {
      seq,
      stepId: stepIdForTrace,
      authoredStepId: step.id,
      block: step.uses,
      status: "failed",
      inputs: resolvedInputs,
      error: error.message,
      startedAt,
      endedAt,
      durationMs,
      ...(dataSecretAccessed
        ? { secretTainted: true, secretTaintedPaths: ["*"] }
        : {}),
    };
  }

  const outputs = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : { value: output };
  const compatibilityProblem = jsonCompatibilityProblem(outputs, `step "${stepIdForTrace}" outputs`);
  if (compatibilityProblem) {
    return {
      seq,
      stepId: stepIdForTrace,
      block: step.uses,
      status: "failed",
      inputs: resolvedInputs,
      error: compatibilityProblem,
      startedAt,
      endedAt,
      durationMs,
      authoredStepId: step.id,
      ...(dataSecretAccessed
        ? { secretTainted: true, secretTaintedPaths: ["*"] }
        : {}),
    };
  }
  // A faked (dry-run) dispatch never records idempotency: recording a
  // synthetic "would have called X" result under the real idempotencyKey
  // would wrongly short-circuit a LATER, genuinely real invocation of this
  // same step into skipping the actual effectful action idempotencyKey
  // exists to gate in the first place.
  if (
    resolvedIdempotencyKey !== undefined &&
    !shouldFake &&
    !dataSecretTaintedBeforeDispatch &&
    !dataSecretAccessed
  ) {
    await recordIdempotency(config.store, resolvedIdempotencyKey, run.runId, stepIdForTrace, outputs, now());
  }
  return {
    seq,
    stepId: stepIdForTrace,
    block: step.uses,
    status: "completed",
    inputs: resolvedInputs,
    outputs,
    startedAt,
    endedAt,
    durationMs,
    authoredStepId: step.id,
    ...(dataSecretAccessed
      ? { secretTainted: true, secretTaintedPaths: ["*"] }
      : {}),
    ...(capturedLlmCall !== undefined ? { llmCall: capturedLlmCall } : {}),
  };
}

async function executeForEachStep(
  config: EngineConfig,
  run: RunRecord,
  step: WorkflowStep,
  resolvedSecretRefs: Set<string>,
  dataSecretTaintedBeforeDispatch: boolean,
): Promise<{ traces: StepTrace[]; failed: boolean }> {
  const baseContext = buildExprContext(run);
  const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
  const resolveOptions: ResolveOptions = { secretResolver };
  const array = await resolveArrayExpression(step.forEach!, baseContext, resolveOptions);

  const limit = config.forEachArrayLimit ?? DEFAULT_FOR_EACH_LIMIT;
  if (array.length > limit) {
    throw new IterationLimitExceededError({
      message: `forEach on step "${step.id}" resolved to an array of ${array.length} elements, exceeding this deployment's configured limit of ${limit} (architecture §4.2's forEach admission-control bound).`,
      detail: { kind: "forEach", stepId: step.id, limit, actual: array.length },
    });
  }

  const asName = step.as ?? "item";
  const traces: StepTrace[] = [];
  const itemOutputs: unknown[] = [];
  let seq = run.trace.length;
  let failed = false;

  for (let index = 0; index < array.length; index++) {
    const item = array[index];
    // See this module's design note (report + code comments in wait-blocks.ts
    // for the analogous choice): the current element is injected into the
    // `steps` root under the `as` name — `@aart/expr`'s grammar is CLOSED to
    // exactly 5 roots (inputs/steps/trigger/run/secrets, architecture §3.1)
    // with no dedicated forEach-binding root, and the parser rejects any
    // other identifier as a root outright (a bare `{{ item }}` is a parse
    // error, not a lookup miss) — so a per-iteration binding cannot be its
    // own root without modifying the frozen @aart/expr package. Nesting it
    // under the EXISTING `steps` root (itself a plain object this package
    // already constructs, architecture §3.2's "@aart/expr... just walks
    // whatever object graph it's handed") is the non-invasive alternative:
    // an author/step references the current element as `{{ steps.item }}`
    // (or `{{ steps.item.someField }}`), using `as`'s given name in place of
    // "item" as the key. NOTE: if a real step in this workflow happens to
    // share an id with `as`, this iteration's synthetic binding shadows it
    // for the duration of this dispatch — an authoring collision to avoid,
    // not one this engine guards against structurally.
    const iterationContext: ExprContext = {
      ...baseContext,
      steps: { ...(baseContext.steps as Record<string, unknown>), [asName]: item },
    };
    const resolvedInputs = await resolveWithRecord(step.with, iterationContext, resolveOptions);
    const stepIdForTrace = `${step.id}[${index}]`;
    const trace = await dispatchOnce(
      config,
      run,
      step,
      stepIdForTrace,
      seq,
      resolvedInputs,
      iterationContext,
      resolveOptions,
      resolvedSecretRefs,
      dataSecretTaintedBeforeDispatch,
    );
    trace.authoredStepId = step.id;
    trace.iterationIndex = index;
    seq += 1;
    traces.push(trace);
    itemOutputs.push(trace.status === "completed" ? trace.outputs : null);
    if (trace.status === "failed") {
      failed = true;
      break; // fail-fast — architecture doesn't specify partial-forEach continuation; this engine stops at the first iteration failure, same as a normal step failing (see this session's report).
    }
  }

  const now = (config.now?.() ?? new Date()).toISOString();
  const firstFailure = traces.find((t) => t.status === "failed");
  const aggregate: StepTrace = {
    seq: seq,
    stepId: step.id,
    block: step.uses,
    status: failed ? "failed" : "completed",
    inputs: { forEach: step.forEach, as: asName, count: array.length },
    outputs: { items: itemOutputs },
    error: firstFailure?.error,
    startedAt: traces[0]?.startedAt ?? now,
    endedAt: now,
    durationMs: traces.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
    authoredStepId: step.id,
  };

  return { traces: [...traces, aggregate], failed };
}

/**
 * Appends `newTraces` to `run.trace`, refreshes `run.artifacts`, redacts,
 * persists, and returns the updated `RunRecord`. Every step-completion path
 * (normal, forEach, skipped) funnels through this one function so
 * persistence + redaction happen identically everywhere.
 *
 * S10 completion fix, found while building the verify-loop E2E (a REAL
 * aart_verify call against a REAL browser.screenshot step — the class of
 * bug per-package testing against stubs structurally cannot catch, same
 * story as A27's redaction bug): `RunRecord.artifacts` was set to `[]` at
 * run creation (run-lifecycle.ts) and then NEVER updated anywhere — a block
 * calling `ctx.writeArtifact` genuinely persists real bytes to
 * `store.artifacts` (step-executor.ts's `buildBlockContext`), but nothing
 * ever reflected that write back onto the RunRecord itself, so every
 * evidence report (`@aart/evidence`'s `renderModelFacing`, which builds
 * `artifactRefs` from `run.artifacts`) silently showed zero artifacts for
 * every run, no matter how many screenshots/downloads/reports a workflow
 * actually captured. Refreshing from `store.artifacts.listByRun(runId)`
 * here — rather than threading artifact-collection through `dispatchOnce`'s
 * own closures, the way `capturedLlmCall` works — means this is correct
 * regardless of how many artifacts a step wrote (zero, one, or several)
 * without adding new per-call bookkeeping: by the time this function runs,
 * `dispatchOnce` has already returned, so any `writeArtifact` calls the
 * step made are already durably in the store, ready to query.
 */
async function appendTracesAndPersist(config: EngineConfig, run: RunRecord, newTraces: StepTrace[], resolvedSecretRefs: ReadonlySet<string>): Promise<RunRecord> {
  const artifacts = await config.store.artifacts.listByRun(run.runId);
  const updated: RunRecord = { ...run, trace: [...run.trace, ...newTraces], artifacts, updatedAt: (config.now?.() ?? new Date()).toISOString() };
  const redacted = applyRunRedaction(config.redact, updated, resolvedSecretRefs);
  await config.store.runs.put(redacted);
  return redacted;
}

export function authoredStepIdForTrace(
  workflow: Workflow,
  trace: StepTrace,
): string {
  if (trace.authoredStepId !== undefined) return trace.authoredStepId;
  if (
    workflow.execution.steps.some((step) => step.id === trace.stepId)
  ) {
    return trace.stepId;
  }
  const match = /^(.*)\[(\d+)\]$/.exec(trace.stepId);
  if (
    match &&
    workflow.execution.steps.some(
      (step) => step.id === match[1] && step.forEach !== undefined,
    )
  ) {
    return match[1]!;
  }
  return trace.stepId;
}

function pointerForOutputPath(
  path: ReturnType<typeof parseExpression>["path"],
): string | undefined {
  if (
    path[1]?.kind !== "property" ||
    path[1].name !== "outputs"
  ) {
    return undefined;
  }
  return path
    .slice(2)
    .map((segment) =>
      segment.kind === "property"
        ? `/${segment.name.replaceAll("~", "~0").replaceAll("/", "~1")}`
        : `/${segment.index}`,
    )
    .join("");
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === "*" || right === "") return true;
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function valueReferencesSecretTaintedTrace(
  expression: unknown,
  run: RunRecord,
  shadowedStepId?: string,
): boolean {
    if (Array.isArray(expression)) {
      return expression.some((value) =>
        valueReferencesSecretTaintedTrace(value, run, shadowedStepId),
      );
    }
    if (expression !== null && typeof expression === "object") {
      return Object.values(expression).some((value) =>
        valueReferencesSecretTaintedTrace(value, run, shadowedStepId),
      );
    }
    if (typeof expression !== "string") return false;
    for (const token of findExpressionTokens(expression)) {
      const parsed = parseExpression(token[0]);
      const first = parsed.path[0];
      if (parsed.root !== "steps") continue;
      if (first === undefined) {
        const latestByStepId = new Map<string, StepTrace>();
        for (const trace of run.trace) latestByStepId.set(trace.stepId, trace);
        if (
          [...latestByStepId.values()].some(
            (trace) =>
              (trace.secretTainted === true ||
                trace.controlSecretTainted === true) &&
              trace.stepId !== shadowedStepId,
          )
        ) {
          return true;
        }
        continue;
      }
      if (first.kind !== "property") continue;
      if (first.name === shadowedStepId) continue;
      const source = run.trace.filter((trace) => trace.stepId === first.name).at(-1);
      if (source?.controlSecretTainted === true) return true;
      if (source?.secretTainted !== true) continue;
      const pointer = pointerForOutputPath(parsed.path);
      if (pointer === undefined) return true;
      const paths =
        source.secretTaintedPaths ??
        (source.secretTainted === true ? ["*"] : []);
      if (paths.some((path) => pathsOverlap(path, pointer))) return true;
    }
    return false;
}

function valueReferencesSecret(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(valueReferencesSecret);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(valueReferencesSecret);
  }
  if (typeof value !== "string") return false;
  return findExpressionTokens(value).some(
    (token) => parseExpression(token[0]).root === "secrets",
  );
}

function runHasSecretControlledFlow(
  run: RunRecord,
): boolean {
  return run.trace.some((trace) => trace.controlSecretTainted === true);
}

function annotateSecretTaint(
  config: EngineConfig,
  traces: StepTrace[],
  resolvedSecretRefs: ReadonlySet<string>,
  dataTaint: boolean,
  controlTaint = false,
): StepTrace[] {
  return traces.map((trace) => {
    const redactedOutputs =
      trace.outputs === undefined
        ? undefined
        : applyRedaction(config.redact, trace.outputs, resolvedSecretRefs);
    const discoveredPaths =
      trace.outputs === undefined || redactedOutputs === undefined
        ? []
        : changedJsonPointers(trace.outputs, redactedOutputs);
    const existingPaths = trace.secretTaintedPaths ?? [];
    const outputTainted =
      dataTaint ||
      existingPaths.length > 0 ||
      discoveredPaths.length > 0;
    if (!outputTainted && !controlTaint) return trace;
    return {
      ...trace,
      secretTainted: true,
      ...(outputTainted
        ? {
            secretTaintedPaths:
              dataTaint || existingPaths.includes("*")
                ? ["*"]
                : [...new Set([...existingPaths, ...discoveredPaths])],
          }
        : { secretTaintedPaths: [] }),
      ...(controlTaint ? { controlSecretTainted: true } : {}),
    };
  });
}

function recomputeDataSecretTaint(
  config: EngineConfig,
  step: WorkflowStep,
  run: RunRecord,
  resolvedSecretRefs: ReadonlySet<string>,
): boolean {
  const taintAwareTrace = annotateSecretTaint(
    config,
    run.trace,
    resolvedSecretRefs,
    false,
  );
  const taintAwareRun = { ...run, trace: taintAwareTrace };
  const iterationBinding =
    step.forEach === undefined ? undefined : (step.as ?? "item");
  return [
    ...Object.values(step.with ?? {}),
    step.idempotencyKey,
    step.forEach,
  ].some((expression) =>
    valueReferencesSecretTaintedTrace(
      expression,
      taintAwareRun,
      iterationBinding,
    ),
  );
}

export async function refreshTaintAfterControlResolution(
  config: EngineConfig,
  step: WorkflowStep,
  run: RunRecord,
  currentTraceCount: number,
  resolvedSecretRefs: ReadonlySet<string>,
  secretCountBeforeResolution: number,
): Promise<RunRecord> {
  let refreshedTrace = annotateSecretTaint(
    config,
    run.trace,
    resolvedSecretRefs,
    false,
  );
  const directlySecretControlled =
    valueReferencesSecret(step.if) ||
    (step.next !== undefined && valueReferencesSecret(step.until));
  const indirectlySecretControlled =
    valueReferencesSecretTaintedTrace(step.if, {
      ...run,
      trace: refreshedTrace,
    }) ||
    (step.next !== undefined &&
      valueReferencesSecretTaintedTrace(step.until, {
        ...run,
        trace: refreshedTrace,
      }));
  if (
    directlySecretControlled ||
    indirectlySecretControlled ||
    runHasSecretControlledFlow(run)
  ) {
    const currentTraceStart = Math.max(
      0,
      refreshedTrace.length - currentTraceCount,
    );
    refreshedTrace = refreshedTrace.map((trace, index) =>
      index >= currentTraceStart
        ? {
            ...trace,
            secretTainted: true,
            secretTaintedPaths: trace.secretTaintedPaths ?? [],
            controlSecretTainted: true,
          }
        : trace,
    );
  }

  const taintChanged = refreshedTrace.some(
    (trace, index) =>
      trace.secretTainted !== run.trace[index]?.secretTainted ||
      trace.controlSecretTainted !==
        run.trace[index]?.controlSecretTainted ||
      JSON.stringify(trace.secretTaintedPaths) !==
        JSON.stringify(run.trace[index]?.secretTaintedPaths),
  );
  if (
    !taintChanged &&
    resolvedSecretRefs.size === secretCountBeforeResolution
  ) {
    return run;
  }

  const refreshedRun = applyRunRedaction(
    config.redact,
    {
      ...run,
      trace: refreshedTrace,
      updatedAt: (config.now?.() ?? new Date()).toISOString(),
    },
    resolvedSecretRefs,
  );
  await config.store.runs.put(refreshedRun);
  return refreshedRun;
}

/**
 * Determines the next step id given the just-executed (or just-skipped)
 * step and whether `step.if` was evaluated. Priority order (architecture
 * §4.2's pipeline, last line): `step.next` (explicit) > `step.then`/`step.else`
 * (from `if`) > next sequential step in `steps[]` array — with `until`
 * (spec §18.2/architecture §4.2) able to SUPPRESS `step.next` specifically
 * when it evaluates true ("the back-edge is not taken and execution falls
 * through normally"), demoting resolution to the next tier as if `next`
 * were absent.
 */
async function determineNextStepId(
  workflow: Workflow,
  step: WorkflowStep,
  run: RunRecord,
  ifResult: boolean | undefined,
  resolvedSecretRefs: Set<string>,
  config: EngineConfig,
): Promise<string | undefined> {
  if (step.next !== undefined) {
    if (step.until !== undefined) {
      const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
      const context = buildExprContext(run); // `run` here already includes this step's fresh trace entry — see call site.
      const untilTrue = await resolveBooleanExpression(step.until, context, { secretResolver });
      if (!untilTrue) {
        return step.next;
      }
      // until === true: exit the loop, fall through as if `next` were absent.
    } else {
      return step.next;
    }
  }
  if (ifResult !== undefined) {
    return (ifResult ? step.then : step.else) ?? nextStepIdInArrayOrder(workflow, step.id);
  }
  return nextStepIdInArrayOrder(workflow, step.id);
}

/**
 * The full per-step dispatch pipeline (architecture §4.2). Returns a
 * `StepOutcome` telling the run-loop (`run-lifecycle.ts`) whether to
 * continue to `nextStepId`, stop because the run is now waiting, or stop
 * because the step failed.
 */
export async function executeStep(
  config: EngineConfig,
  run: RunRecord,
  workflow: Workflow,
  step: WorkflowStep,
  resolvedSecretRefs: Set<string>,
  environment: string | undefined,
): Promise<StepOutcome> {
  const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
  const resolveOptions: ResolveOptions = { secretResolver };
  const exprContextBeforeDispatch = buildExprContext(run);
  let dataSecretTaint =
    (step.forEach === undefined &&
      Object.values(step.with ?? {}).some(valueReferencesSecret)) ||
    valueReferencesSecret(step.forEach) ||
    valueReferencesSecret(step.idempotencyKey) ||
    recomputeDataSecretTaint(config, step, run, resolvedSecretRefs);
  let controlSecretTaint =
    runHasSecretControlledFlow(run) ||
    valueReferencesSecret(step.if) ||
    valueReferencesSecretTaintedTrace(step.if, run);

  // 1. resolve step.with — EXCEPT for a forEach step, whose `with:` is
  // resolved per-iteration instead (executeForEachStep, below), with the
  // `as`-bound current element injected into context. Resolving it here
  // too, unconditionally, would fail outright for any `with:` value that
  // references the (not-yet-bound) forEach item — this isn't just wasted
  // work, it's a genuine bug: `{{ steps.item }}` has no meaning until a
  // specific iteration's context exists.
  const resolvedWith = step.forEach === undefined ? await resolveWithRecord(step.with, exprContextBeforeDispatch, resolveOptions) : {};
  dataSecretTaint ||= recomputeDataSecretTaint(
    config,
    step,
    run,
    resolvedSecretRefs,
  );

  // 2. check step.if — architecture micro-decision #7: absent `if` always
  // falls through; `then`/`else` only consulted when `if` is present.
  let ifResult: boolean | undefined;
  if (step.if !== undefined) {
    ifResult = await resolveBooleanExpression(step.if, exprContextBeforeDispatch, resolveOptions);
    controlSecretTaint ||=
      valueReferencesSecret(step.if) ||
      valueReferencesSecretTaintedTrace(step.if, run);
    if (!ifResult) {
      const now = (config.now?.() ?? new Date()).toISOString();
      const skippedTrace: StepTrace = {
        seq: run.trace.length,
        stepId: step.id,
        block: step.uses,
        status: "skipped",
        inputs: resolvedWith,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        authoredStepId: step.id,
      };
      const updatedRun = await appendTracesAndPersist(
        config,
        run,
        annotateSecretTaint(
          config,
          [skippedTrace],
          resolvedSecretRefs,
          dataSecretTaint,
          controlSecretTaint,
        ),
        resolvedSecretRefs,
      );
      const nextStepId = step.next ?? step.else ?? nextStepIdInArrayOrder(workflow, step.id);
      return { kind: "continue", run: updatedRun, nextStepId };
    }
  }

  // Guarded back-edge cap (spec §18.2, architecture §4.2). `[DECISION]`
  // (see this session's report for the fuller rationale): rather than
  // detecting "is this specific `next` a back-edge" via array-index
  // comparison, `maxIterations` is enforced uniformly on whichever step
  // declares it, every time that step is about to execute — this correctly
  // bounds a cycle regardless of which step in it "starts" the loop, as
  // long as at least one step in the cycle declares a cap (which
  // validation, spec §18.2/S4's scope, is what enforces at author-time; a
  // cycle with NO guard anywhere is a validation error before it ever
  // reaches this engine). `priorExecutions` is derived from `run.trace`
  // (not separate in-memory counter state), so it's correct across a
  // restart mid-loop.
  if (step.maxIterations !== undefined) {
    const priorExecutions = countPriorExecutions(run, step.id);
    if (priorExecutions >= step.maxIterations) {
      throw new IterationLimitExceededError({
        message: `Step "${step.id}" has already executed ${priorExecutions} time(s), reaching its declared maxIterations of ${step.maxIterations} (spec §18.2's guarded back-edge cap).`,
        detail: { kind: "guardedBackEdge", stepId: step.id, maxIterations: step.maxIterations, priorExecutions },
      });
    }
  }

  // Wait-type block? Architecture §4.2: "dispatch to block
  // (native/workflow/node/command/connector/wait — §15.1)" — `wait` gets
  // engine-level special-casing (wait/wait-machine.ts) BEFORE the normal
  // capability-check/dispatch path, since entering a wait persists+suspends
  // rather than calling a block's `execute()` at all (see wait-blocks.ts's
  // module doc comment for the fuller design rationale).
  if (isWaitBlockId(step.uses)) {
    const waitDataSecretTainted =
      dataSecretTaint ||
      !jsonValuesEqual(
        resolvedWith,
        applyRedaction(config.redact, resolvedWith, resolvedSecretRefs),
      );
    return executeWaitDispatch(
      config,
      run,
      workflow,
      step,
      resolvedWith,
      resolvedSecretRefs,
      ifResult,
      waitDataSecretTainted,
      controlSecretTaint,
    );
  }

  dataSecretTaint ||=
    step.forEach !== undefined &&
    Object.values(step.with ?? {}).some(valueReferencesSecret);

  const impl = config.resolveBlockForRun?.(run, step.uses) ?? config.blocks[step.uses];
  if (!impl) {
    throw new Error(`No BlockImplementation registered for block id "${step.uses}" (step "${step.id}") — register it on EngineConfig.blocks before dispatch.`);
  }

  // 3. capability check (architecture §4.6, ADR-09) — one call site.
  await checkCapabilityDispatch(
    impl.manifest.capabilities,
    workflow,
    environment,
    { capabilityCheck: config.capabilityCheck, getGrantedCapabilities: config.getGrantedCapabilities ?? alwaysEmptyGrantedCapabilities },
    { runId: run.runId, stepId: step.id, blockId: step.uses },
  );

  // 4. forEach or single dispatch.
  const newTraces: StepTrace[] = [];
  let stepFailed = false;
  if (step.forEach !== undefined) {
    const result = await executeForEachStep(
      config,
      run,
      step,
      resolvedSecretRefs,
      dataSecretTaint,
    );
    newTraces.push(...result.traces);
    stepFailed = result.failed;
  } else {
    const trace = await dispatchOnce(
      config,
      run,
      step,
      step.id,
      run.trace.length,
      resolvedWith,
      exprContextBeforeDispatch,
      resolveOptions,
      resolvedSecretRefs,
      dataSecretTaint,
    );
    newTraces.push(trace);
    stepFailed = trace.status === "failed";
  }

  dataSecretTaint ||= recomputeDataSecretTaint(
    config,
    step,
    run,
    resolvedSecretRefs,
  );
  const taintAnnotatedTraces = annotateSecretTaint(
    config,
    newTraces,
    resolvedSecretRefs,
    dataSecretTaint,
    controlSecretTaint,
  );
  const provisionalRun: RunRecord = {
    ...run,
    trace: [...run.trace, ...taintAnnotatedTraces],
  };

  if (stepFailed) {
    const updatedRun = await appendTracesAndPersist(
      config,
      run,
      taintAnnotatedTraces,
      resolvedSecretRefs,
    );
    const failure = taintAnnotatedTraces[taintAnnotatedTraces.length - 1]!;
    return { kind: "failed", run: updatedRun, error: new Error(failure.error ?? `Step "${step.id}" failed.`) };
  }

  const nextStepId = await determineNextStepId(
    workflow,
    step,
    provisionalRun,
    ifResult,
    resolvedSecretRefs,
    config,
  );
  controlSecretTaint ||=
    valueReferencesSecret(step.until) ||
    valueReferencesSecretTaintedTrace(step.until, provisionalRun);
  const finalTraces = annotateSecretTaint(
    config,
    taintAnnotatedTraces,
    resolvedSecretRefs,
    dataSecretTaint,
    controlSecretTaint,
  );
  const updatedRun = await appendTracesAndPersist(
    config,
    run,
    finalTraces,
    resolvedSecretRefs,
  );
  return { kind: "continue", run: updatedRun, nextStepId };
}

/**
 * Handles a wait-type step's dispatch: resolves the block-id-specific
 * `WaitCondition` (special-casing `human.approval`, which needs an
 * `ApprovalTask` minted first — architecture §13.5/§4.4.1), stamps this
 * engine's schema-version tag, and calls `wait/wait-machine.ts`'s
 * `enterWait`.
 */
async function executeWaitDispatch(
  config: EngineConfig,
  run: RunRecord,
  workflow: Workflow,
  step: WorkflowStep,
  resolvedWith: Record<string, unknown>,
  resolvedSecretRefs: Set<string>,
  ifResult: boolean | undefined,
  dataSecretTainted: boolean,
  controlSecretTainted: boolean,
): Promise<StepOutcome> {
  const schemaVersion = config.schemaVersion ?? CURRENT_ENGINE_SCHEMA_VERSION;
  const waitMachineConfig: WaitMachineConfig = { store: config.store, redact: config.redact, now: config.now ?? (() => new Date()) };

  let wait: WaitCondition;
  if (step.uses === "human.approval") {
    const taskId = crypto.randomUUID();
    const now = (config.now?.() ?? new Date()).toISOString();
    // A41 redaction fix: title/description come from `resolvedWith` — the
    // step's `with:` block AFTER template resolution (resolveWithRecord,
    // called by executeStep before dispatch) — so a workflow author
    // referencing `{{ secrets.X }}` in a human.approval step's title/
    // description would otherwise persist the raw resolved secret value
    // into a brand-new ApprovalTask row right here, never redacted: this
    // was the one persist call site in this file that built its record and
    // called `config.store.X.put(...)` directly without first routing
    // through `applyRedaction`, even though `resolvedSecretRefs` is already
    // a live parameter of this very function. ApprovalTask is a separate
    // store collection from the WaitCondition `enterWait` redacts below, so
    // that later redaction never covered this earlier write.
    const approvalTask: ApprovalTask = {
      id: taskId,
      runId: run.runId,
      stepId: step.id,
      title: typeof resolvedWith.title === "string" ? resolvedWith.title : `Approve step "${step.id}"`,
      description: typeof resolvedWith.description === "string" ? resolvedWith.description : "",
      status: "pending",
      createdAt: now,
    };
    await config.store.approvals.put(applyRedaction(config.redact, approvalTask, resolvedSecretRefs));
    wait = { type: "approval", taskId, timeout: typeof resolvedWith.timeout === "string" ? resolvedWith.timeout : undefined, schemaVersion };
  } else {
    wait = buildWaitConditionFromBlock(step.uses as Exclude<WaitBlockId, "human.approval">, resolvedWith, schemaVersion);
  }

  let preparedNextStepId: string | undefined;
  const result = await enterWait(waitMachineConfig, {
    run,
    stepId: step.id,
    blockId: step.uses,
    resolvedInputs: resolvedWith,
    wait,
    resolvedSecretRefs,
    secretTainted: dataSecretTainted,
    controlSecretTainted,
    prepareEarlyArrivalRun: async (provisionalRun) => {
      preparedNextStepId = await determineNextStepId(
        workflow,
        step,
        provisionalRun,
        ifResult,
        resolvedSecretRefs,
        config,
      );
      const untilSecretControlled =
        valueReferencesSecret(step.until) ||
        valueReferencesSecretTaintedTrace(step.until, provisionalRun);
      if (!controlSecretTainted && !untilSecretControlled) {
        return provisionalRun;
      }
      const trace = provisionalRun.trace.map((entry, index) =>
        index === provisionalRun.trace.length - 1
          ? {
              ...entry,
              secretTainted: true,
              secretTaintedPaths: entry.secretTaintedPaths ?? [],
              controlSecretTainted: true,
            }
          : entry,
      );
      return { ...provisionalRun, trace };
    },
  });

  if (!result.suspended) {
    // Early-arrival resolution — continue exactly as if this step completed
    // normally (architecture §4.4 step 3).
    return {
      kind: "continue",
      run: result.run,
      nextStepId: preparedNextStepId,
    };
  }
  return { kind: "waiting", run: result.run };
}

export { countPriorExecutions, determineNextStepId, nextStepIdInArrayOrder };
