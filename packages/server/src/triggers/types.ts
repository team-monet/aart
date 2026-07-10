// Trigger subsystem shared types — architecture §6 (full trigger subsystem).
import type { ConcurrencyPolicy, MissedRunPolicy, Trigger, TriggerType } from "@aart/types";

/**
 * A configured binding of one trigger definition (spec §21.2's YAML shape:
 * `triggers: [{ id, type, path/cron/event/... }]` + `triggerMapping`,
 * §21.3) to a workflow. Not itself a frozen `@aart/types` type (spec/
 * architecture never name a `TriggerBinding`/`TriggerDefinition` type) —
 * this package's own configuration shape, generic enough to cover all 13
 * `Trigger.type` members.
 *
 * Persistence note (see this task's final report / SEAMS.md): `schedule`
 * bindings are backed 1:1 by the already-frozen `Schedule` store member
 * (architecture §5.3 — id/workflowId/workflowVersion/cron/timezone/
 * missedRunPolicy/inputs/paused already covers everything a schedule
 * binding needs) and this package's ticker reads `Schedule` records
 * directly rather than duplicating that shape here. The other 12 types
 * have no dedicated store member; this package models their config as
 * plain `TriggerBinding` objects the caller supplies to `startServer`/
 * `startWorker` (directly, or via `loadTriggerBindingsFromDeployments`,
 * which reads them out of the already-frozen `Deployment.triggerConfig`
 * bag, architecture ADR-06) — the CLI/dashboard-facing "author a trigger
 * config" surface itself (spec's `aart trigger add`) is `@aart/cli`'s
 * (S5's) command to build; this package consumes whatever ends up in
 * `Deployment.triggerConfig`, it doesn't own authoring it.
 */
export interface TriggerBinding {
  /** Stable id for this binding — becomes `Trigger.source` for adapters that don't have a more specific natural source id. */
  id: string;
  type: TriggerType;
  workflowId: string;
  workflowVersion?: string;
  deploymentId?: string;
  /** spec §21.3 `triggerMapping`: `{{ }}` expressions (resolved against `{ trigger }`, architecture §6.2) producing the run's mapped inputs. Absent means "pass the whole delivery payload through as inputs" (a reasonable default for adapters like `manual`/`cli`/`sdk` that are usually invoked with already-shaped input). */
  triggerMapping?: Record<string, string>;
  /** architecture §6.3: "is this a new-run trigger or a resume-signal — made by trigger TYPE, not by inspecting payload shape." `"start"` unless noted otherwise per adapter. */
  mode: "start" | "resume";
  /** For a `"resume"` binding: the `Signal.name` an inbound delivery synthesizes (architecture §4.4.1's signal-matched resume path). */
  signalName?: string;
  concurrencyPolicy?: ConcurrencyPolicy;
  concurrencyKeyExpr?: string;

  // --- webhook ---
  webhookPath?: string;
  /** A `secrets.<NAME>` reference (architecture §6.1/§15: "the HMAC secret is itself a secrets.<NAME>-referenced value... never a plaintext config value"), resolved via `SharedRuntimeConfig.secretResolver`. */
  webhookHmacSecretRef?: string;
  /** Which HTTP header carries the delivery's HMAC signature (e.g. `X-Hub-Signature-256` for GitHub). Defaults to `x-aart-signature`. */
  webhookSignatureHeader?: string;

  // --- schedule (only used if this binding is supplied directly rather than sourced from a Schedule record) ---
  cron?: string;
  timezone?: string;
  missedRunPolicy?: MissedRunPolicy;

  // --- poll ---
  pollUrl?: string;
  pollIntervalMs?: number;
  /** `{{ }}` expression over the poll response (architecture §6.1 `[DECISION]`) — fires only when true. */
  pollCondition?: string;
  /** Custom fetch, primarily for tests — defaults to the global `fetch`. */
  pollFetch?: (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;

  // --- github ---
  githubEvent?: string;

  // --- generic natural-delivery-id header name for dedupeKey extraction (architecture §6.1's FLAGGED DIVERGENCE) ---
  dedupeHeaderName?: string;
}

/** What an inbound delivery looks like before it's turned into a `Trigger` — the common shape every adapter's handler accepts, regardless of transport (HTTP body, CLI argv, an SDK call's in-process arguments, ...). */
export interface InboundDelivery {
  payload: unknown;
  headers?: Record<string, string | undefined>;
  /** Raw bytes, when available — required for HMAC verification (architecture §6.1), which must be computed over the exact wire bytes, not a re-serialized JSON re-encoding of `payload` (a re-encoding can byte-differ from what the sender actually signed). */
  rawBody?: Uint8Array;
  receivedAt?: string;
}

/** The result of turning an `InboundDelivery` into a `Trigger` plus intake routing metadata — every per-type adapter (manual.ts-equivalent handlers in adapters.ts) produces this uniform shape, which `intake.ts`'s shared pipeline then processes identically regardless of source type (architecture §6.1: "All adapters share one contract"). */
export interface AdaptedTrigger {
  trigger: Trigger;
  /** Present when this delivery should be routed as a resume (architecture §6.3) rather than a new-run start — carries the Signal that should be synthesized. */
  resumeSignal?: { name: string; correlationId: string; payload: unknown };
}

export type TriggerRejectionReason =
  | "bad_hmac"
  | "input_mapping_failed"
  | "concurrency_rejected"
  | "backlog_ceiling"
  | "poison_flagged"
  | "duplicate_delivery";

export type IntakeOutcome =
  | { kind: "started"; runId: string }
  | { kind: "queued"; runId: string }
  | { kind: "resumed"; runId: string }
  | { kind: "duplicate_resume"; runId: string }
  | { kind: "no_match" }
  | { kind: "ambiguous"; matches: number }
  | { kind: "rejected"; reason: TriggerRejectionReason; detail?: string };
