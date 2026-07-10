// AartError hierarchy — architecture §8 "Error-Type Taxonomy".
//
// A shared, S0-frozen error class hierarchy used consistently by engine
// retry matching (architecture §4.2), reports (§9), and MCP error surfaces
// (spec §32.2b). Placed in @aart/types (not a separate @aart/errors
// package) per architecture §8's own stated choice, to avoid a trivial
// extra package.
//
// Every subclass carries enough structure to appear distinctly in
// StepTrace.error and in ModelFacingReport.failures[] (spec §32.7) — the
// model-facing report's whole value proposition (stable keys,
// headline-and-failures-first) depends on failures being classifiable, not
// raw stringified exceptions. `errorClass` is what engine retry matching
// (RetryPolicy.retryOn, architecture micro-decision #9) compares against,
// normalized rather than a raw string compare against exception messages.

export interface AartErrorOptions {
  message: string;
  /** Structured detail relevant to this specific error class. Never put a raw secret value here — this flows through the redaction chokepoint (architecture §7.9) like any other persisted/emitted field. */
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export abstract class AartError extends Error {
  /** Stable, serializable discriminant — this is what RetryPolicy.retryOn (architecture micro-decision #9) and report renderers match against, not `error.message` or `error.constructor.name`. */
  abstract readonly errorClass: string;
  readonly detail?: Record<string, unknown>;

  constructor(options: AartErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.detail = options.detail;
  }

  /** Plain-object shape safe to embed in a StepTrace.error / ModelFacingReport.failures[] entry — NOT pre-redacted; callers still route this through the RedactFn/redactRecord chokepoint before persisting or emitting it. */
  toJSON(): { errorClass: string; message: string; detail?: Record<string, unknown> } {
    return { errorClass: this.errorClass, message: this.message, detail: this.detail };
  }
}

/** Validation engine failure — architecture §7.7's five classes; shape includes `class`/`path`/`didYouMean`/`correctedSnippet` per errors-as-corrections design (micro-decision #25). Governance (S4) is the sole owner of raising these; @aart/types only freezes the class and its detail shape. */
export class ValidationError extends AartError {
  readonly errorClass = "ValidationError" as const;
}

/** declared ⊆ granted check failed at the engine's capability-dispatch chokepoint (architecture §4.6, ADR-09). Distinguishable from a generic step failure so it can be surfaced distinctly in traces/reports. */
export class CapabilityDeniedError extends AartError {
  readonly errorClass = "CapabilityDeniedError" as const;
}

/** A step or wait timeout fired. `detail` should say which (e.g. `{ kind: "step" | "wait" }`) — architecture §4.2's per-attempt step timeout and spec §13.3's wait `timeout` member both route through this one class. */
export class TimeoutError extends AartError {
  readonly errorClass = "TimeoutError" as const;
}

/** 4xx from an external call. */
export class HttpClientError extends AartError {
  readonly errorClass = "HttpClientError" as const;
}

/** 5xx from an external call — matches RetryPolicy.retryOn: "5xx" (architecture micro-decision #9). */
export class HttpServerError extends AartError {
  readonly errorClass = "HttpServerError" as const;
}

/** A guarded back-edge's maxIterations was exceeded (spec §18.2), OR an oversized resolved forEach array exceeded the engine's configurable upper bound (architecture §4.2 admission-control gap closure) — same symptom (a loop running far more times than intended), same error class, distinguishable via `detail`. */
export class IterationLimitExceededError extends AartError {
  readonly errorClass = "IterationLimitExceededError" as const;
}

/** architecture §4.4.2 — a signal-matched resume found zero or more-than-one matching WaitCondition. Zero is typically logged/inspectable, not thrown; more-than-one is a modeling error that must fail loudly rather than guess. */
export class CorrelationError extends AartError {
  readonly errorClass = "CorrelationError" as const;
}

/** A referenced `secrets.<NAME>` has no adapter value at resolution time (architecture §3.2/§31.2). */
export class SecretResolutionError extends AartError {
  readonly errorClass = "SecretResolutionError" as const;
}

/** architecture §16.2 — a pack's content hash no longer matches its recorded manifest hash; any edit breaks the approval seal. */
export class PackHashMismatchError extends AartError {
  readonly errorClass = "PackHashMismatchError" as const;
}

/** architecture §4.3 — a `reject_new` ConcurrencyPolicy rejected a new trigger outright at intake, before a RunRecord was even created. */
export class ConcurrencyRejectedError extends AartError {
  readonly errorClass = "ConcurrencyRejectedError" as const;
}

/** All ten AartError subclasses, for exhaustiveness tests and for any call site that wants to enumerate/instanceof-narrow the full taxonomy without hand-maintaining a parallel list. */
export const AART_ERROR_CLASSES = [
  ValidationError,
  CapabilityDeniedError,
  TimeoutError,
  HttpClientError,
  HttpServerError,
  IterationLimitExceededError,
  CorrelationError,
  SecretResolutionError,
  PackHashMismatchError,
  ConcurrencyRejectedError,
] as const;
