// Step execution (architecture §4.2) — the full per-step dispatch pipeline:
// resolve with -> check if -> capability check -> forEach -> dispatch ->
// retry/timeout -> idempotency -> redact -> record StepTrace -> determine
// next. Wait-type block ids (wait/wait-blocks.ts) are intercepted before
// normal dispatch and handed to wait/wait-machine.ts instead.
import type { ExprContext, ResolveOptions } from "@aart/expr";
import type { BlockExecutionContext, RetryPolicy, RunRecord, StepTrace, WaitCondition, Workflow, WorkflowStep } from "@aart/types";
import { AartError, IterationLimitExceededError, TimeoutError } from "@aart/types";
import { checkCapabilityDispatch, alwaysEmptyGrantedCapabilities } from "./capability.js";
import { parseDurationMs } from "./duration.js";
import { buildExprContext, resolveArrayExpression, resolveBooleanExpression, resolveStringExpression, resolveWithRecord } from "./expr-context.js";
import { checkIdempotency, recordIdempotency } from "./idempotency.js";
import { applyRedaction, createTrackingSecretResolver, throwingSecretResolver } from "./redaction.js";
import { CURRENT_ENGINE_SCHEMA_VERSION } from "./schema-version.js";
import type { EngineConfig } from "./types.js";
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

function buildBlockContext(config: EngineConfig, runId: string, stepId: string, secretResolver: ReturnType<typeof createTrackingSecretResolver>): BlockExecutionContext {
  return {
    runId,
    stepId,
    resolveSecret: async (ref: string) => {
      const value = await secretResolver(ref);
      return typeof value === "string" ? value : String(value);
    },
    writeArtifact: async (input) => {
      const id = crypto.randomUUID();
      const path = `artifacts/${runId}/${id}`;
      await config.store.artifacts.put(
        { id, runId, stepId, name: input.name, kind: input.kind, mime: input.mime, path, bytes: input.bytes.byteLength, createdAt: (config.now?.() ?? new Date()).toISOString() },
        input.bytes,
      );
      return { id, path };
    },
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
): Promise<StepTrace> {
  const impl = config.blocks[step.uses];
  if (!impl) {
    throw new Error(`No BlockImplementation registered for block id "${step.uses}" (step "${step.id}") — register it on EngineConfig.blocks before dispatch.`);
  }
  const now = () => config.now?.() ?? new Date();
  const startedAt = now().toISOString();

  const resolvedIdempotencyKey = await resolveStringExpression(step.idempotencyKey, exprContext, resolveOptions);
  if (resolvedIdempotencyKey !== undefined) {
    const check = await checkIdempotency(config.store, resolvedIdempotencyKey);
    if (check.alreadyCompleted) {
      const endedAt = now().toISOString();
      return { seq, stepId: stepIdForTrace, block: step.uses, status: "completed", inputs: resolvedInputs, outputs: check.recordedOutput as Record<string, unknown>, startedAt, endedAt, durationMs: 0 };
    }
  }

  const secretResolver = createTrackingSecretResolver(config.resolveSecret ?? throwingSecretResolver, resolvedSecretRefs);
  const ctx = buildBlockContext(config, run.runId, stepIdForTrace, secretResolver);
  const timeoutMs = step.timeout ? parseDurationMs(step.timeout) : undefined;
  const computeDelay = config.computeRetryDelayMs ?? defaultComputeRetryDelayMs;

  const { output, error } = await dispatchWithRetry(() => impl.execute(resolvedInputs, ctx), step.retry, timeoutMs, computeDelay, { stepId: stepIdForTrace });
  const endedAt = now().toISOString();
  const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());

  if (error) {
    return { seq, stepId: stepIdForTrace, block: step.uses, status: "failed", inputs: resolvedInputs, error: error.message, startedAt, endedAt, durationMs };
  }

  const outputs = output !== null && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : { value: output };
  if (resolvedIdempotencyKey !== undefined) {
    await recordIdempotency(config.store, resolvedIdempotencyKey, run.runId, stepIdForTrace, outputs, now());
  }
  return { seq, stepId: stepIdForTrace, block: step.uses, status: "completed", inputs: resolvedInputs, outputs, startedAt, endedAt, durationMs };
}

async function executeForEachStep(
  config: EngineConfig,
  run: RunRecord,
  step: WorkflowStep,
  resolvedSecretRefs: Set<string>,
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
    const trace = await dispatchOnce(config, run, step, stepIdForTrace, seq, resolvedInputs, iterationContext, resolveOptions, resolvedSecretRefs);
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
  };

  return { traces: [...traces, aggregate], failed };
}

/** Appends `newTraces` to `run.trace`, redacts, persists, and returns the updated `RunRecord`. Every step-completion path (normal, forEach, skipped) funnels through this one function so persistence + redaction happen identically everywhere. */
async function appendTracesAndPersist(config: EngineConfig, run: RunRecord, newTraces: StepTrace[], resolvedSecretRefs: ReadonlySet<string>): Promise<RunRecord> {
  const updated: RunRecord = { ...run, trace: [...run.trace, ...newTraces], updatedAt: (config.now?.() ?? new Date()).toISOString() };
  const redacted = applyRedaction(config.redact, updated, resolvedSecretRefs);
  await config.store.runs.put(redacted);
  return redacted;
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

  // 1. resolve step.with
  const resolvedWith = await resolveWithRecord(step.with, exprContextBeforeDispatch, resolveOptions);

  // 2. check step.if — architecture micro-decision #7: absent `if` always
  // falls through; `then`/`else` only consulted when `if` is present.
  let ifResult: boolean | undefined;
  if (step.if !== undefined) {
    ifResult = await resolveBooleanExpression(step.if, exprContextBeforeDispatch, resolveOptions);
    if (!ifResult) {
      const now = (config.now?.() ?? new Date()).toISOString();
      const skippedTrace: StepTrace = { seq: run.trace.length, stepId: step.id, block: step.uses, status: "skipped", inputs: resolvedWith, startedAt: now, endedAt: now, durationMs: 0 };
      const updatedRun = await appendTracesAndPersist(config, run, [skippedTrace], resolvedSecretRefs);
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
    return executeWaitDispatch(config, run, workflow, step, resolvedWith, resolvedSecretRefs, ifResult);
  }

  const impl = config.blocks[step.uses];
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
    const result = await executeForEachStep(config, run, step, resolvedSecretRefs);
    newTraces.push(...result.traces);
    stepFailed = result.failed;
  } else {
    const trace = await dispatchOnce(config, run, step, step.id, run.trace.length, resolvedWith, exprContextBeforeDispatch, resolveOptions, resolvedSecretRefs);
    newTraces.push(trace);
    stepFailed = trace.status === "failed";
  }

  const updatedRun = await appendTracesAndPersist(config, run, newTraces, resolvedSecretRefs);

  if (stepFailed) {
    const failure = newTraces[newTraces.length - 1]!;
    return { kind: "failed", run: updatedRun, error: new Error(failure.error ?? `Step "${step.id}" failed.`) };
  }

  const nextStepId = await determineNextStepId(workflow, step, updatedRun, ifResult, resolvedSecretRefs, config);
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
): Promise<StepOutcome> {
  const schemaVersion = config.schemaVersion ?? CURRENT_ENGINE_SCHEMA_VERSION;
  const waitMachineConfig: WaitMachineConfig = { store: config.store, redact: config.redact, now: config.now ?? (() => new Date()) };

  let wait: WaitCondition;
  if (step.uses === "human.approval") {
    const taskId = crypto.randomUUID();
    const now = (config.now?.() ?? new Date()).toISOString();
    await config.store.approvals.put({
      id: taskId,
      runId: run.runId,
      stepId: step.id,
      title: typeof resolvedWith.title === "string" ? resolvedWith.title : `Approve step "${step.id}"`,
      description: typeof resolvedWith.description === "string" ? resolvedWith.description : "",
      status: "pending",
      createdAt: now,
    });
    wait = { type: "approval", taskId, timeout: typeof resolvedWith.timeout === "string" ? resolvedWith.timeout : undefined, schemaVersion };
  } else {
    wait = buildWaitConditionFromBlock(step.uses as Exclude<WaitBlockId, "human.approval">, resolvedWith, schemaVersion);
  }

  const result = await enterWait(waitMachineConfig, {
    run,
    stepId: step.id,
    blockId: step.uses,
    resolvedInputs: resolvedWith,
    wait,
    resolvedSecretRefs,
  });

  if (!result.suspended) {
    // Early-arrival resolution — continue exactly as if this step completed
    // normally (architecture §4.4 step 3).
    const nextStepId = await determineNextStepId(workflow, step, result.run, ifResult, resolvedSecretRefs, config);
    return { kind: "continue", run: result.run, nextStepId };
  }
  return { kind: "waiting", run: result.run };
}

export { countPriorExecutions, determineNextStepId, nextStepIdInArrayOrder };
