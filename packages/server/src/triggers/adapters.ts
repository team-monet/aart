// The 13 trigger adapters (architecture §6.1 table). Per this session's
// DoD: manual/cli/mcp/sdk/webhook/schedule/poll are fully real; email/file/
// queue/database/github/slack are interface-complete with a working local/
// fake backend (no specific third-party provider is mandated by the spec
// for any of these six). Every adapter turns an `InboundDelivery` (or, for
// schedule/poll, a fired tick) into an `AdaptedTrigger` (or a rejection),
// which `intake.ts`'s shared pipeline then processes identically —
// "produce a Trigger object... share one contract" (architecture §6.1).
import type { ApprovalTask, Schedule, Trigger, TriggerType } from "@aart/types";
import type { AartStore } from "@aart/store";
import type { Clock } from "../clock.js";
import { generateId } from "../ids.js";
import { verifyHmacSignature } from "./hmac.js";
import type { AdaptedTrigger, InboundDelivery, TriggerBinding } from "./types.js";

export type AdapterResult = AdaptedTrigger | { rejected: "bad_hmac" };

function baseTrigger(type: TriggerType, source: string, delivery: InboundDelivery, clock: Clock, extra: Partial<Trigger> = {}): Trigger {
  return {
    type,
    id: generateId("trig"),
    source,
    payload: delivery.payload,
    correlationId: undefined,
    receivedAt: delivery.receivedAt ?? clock.nowIso(),
    ...extra,
  } as Trigger;
}

/** Extracts a natural delivery id for `Trigger.dedupeKey` (architecture §6.1's FLAGGED DIVERGENCE) from whichever header the adapter names — `X-GitHub-Delivery`, a queue message id, an email `Message-ID`. Case-insensitive (HTTP header names arrive lowercased through most server frameworks, but callers may supply either case). */
function headerValue(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fully real: manual / cli / mcp / sdk — no natural transport-level
// dedup/correlation concerns (each is a direct, synchronous, already-
// trusted-caller invocation, architecture §6.1's table).
// ---------------------------------------------------------------------------

export function adaptManualTrigger(binding: TriggerBinding, delivery: InboundDelivery, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("manual", binding.id, delivery, clock) };
}

export function adaptCliTrigger(binding: TriggerBinding, delivery: InboundDelivery, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("cli", binding.id, delivery, clock) };
}

export function adaptMcpTrigger(binding: TriggerBinding, delivery: InboundDelivery, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("mcp", binding.id, delivery, clock) };
}

export function adaptSdkTrigger(binding: TriggerBinding, delivery: InboundDelivery, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("sdk", binding.id, delivery, clock) };
}

// ---------------------------------------------------------------------------
// webhook — HMAC verification is MANDATORY (architecture §6.1/§15); a
// missing/invalid signature never reaches Trigger construction.
// ---------------------------------------------------------------------------

export function adaptWebhookTrigger(binding: TriggerBinding, delivery: InboundDelivery, secret: string | undefined, clock: Clock): AdapterResult {
  const signatureHeader = headerValue(delivery.headers, binding.webhookSignatureHeader ?? "x-aart-signature");
  const rawBody = delivery.rawBody ?? new TextEncoder().encode(JSON.stringify(delivery.payload));
  if (!verifyHmacSignature(rawBody, signatureHeader, secret ?? "")) {
    return { rejected: "bad_hmac" };
  }
  const dedupeKey = binding.dedupeHeaderName ? headerValue(delivery.headers, binding.dedupeHeaderName) : undefined;
  const correlationId = typeof (delivery.payload as { correlationId?: unknown } | null)?.["correlationId" as never] === "string" ? (delivery.payload as { correlationId: string }).correlationId : undefined;
  const trigger = baseTrigger("webhook", binding.id, delivery, clock, { dedupeKey, correlationId });
  if (binding.mode === "resume" && binding.signalName && correlationId) {
    return { trigger, resumeSignal: { name: binding.signalName, correlationId, payload: delivery.payload } };
  }
  return { trigger };
}

// ---------------------------------------------------------------------------
// schedule — driven by the ticker (ticker/ticker.ts), not an inbound
// delivery; `Schedule` (architecture §5.3) already carries every field a
// schedule binding needs, so this adapts a fired `Schedule` row directly.
// ---------------------------------------------------------------------------

export function adaptScheduleFire(schedule: Schedule, firedAt: string, clock: Clock): AdaptedTrigger {
  return {
    trigger: {
      type: "schedule",
      id: generateId("trig"),
      source: schedule.id,
      payload: { scheduleId: schedule.id, firedAt, inputs: schedule.inputs ?? {} },
      receivedAt: clock.nowIso(),
    },
  };
}

// ---------------------------------------------------------------------------
// poll — driven by the ticker; the ticker owns the actual HTTP fetch +
// interval bookkeeping (ticker/poll-runner.ts), this adapter's job is just
// "given a poll response that satisfied `pollCondition`, produce a Trigger."
// ---------------------------------------------------------------------------

export function adaptPollFire(binding: TriggerBinding, pollResponse: unknown, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("poll", binding.id, { payload: pollResponse }, clock) };
}

// ---------------------------------------------------------------------------
// email / file / queue / database — interface-complete, local/fake-backed
// per this session's DoD (no specific provider mandated by the spec).
// ---------------------------------------------------------------------------

/** spec §13.3's own note: "email replies are Signals, not a distinct wait type" — an inbound email is ALWAYS converted to a Signal at ingress (architecture §6.1's table), correlated by a caller-supplied correlationId extraction (e.g. an in-reply-to header, or a token embedded in the original outbound email's body — provider-specific, hence this being a documented extension point rather than a fixed header name). Tested against a local fake inbound-parse endpoint (this session's DoD), never a real transactional email provider. */
export function adaptEmailTrigger(binding: TriggerBinding, delivery: InboundDelivery, clock: Clock, extractCorrelationId: (delivery: InboundDelivery) => string | undefined): AdaptedTrigger {
  const dedupeKey = headerValue(delivery.headers, binding.dedupeHeaderName ?? "message-id");
  const correlationId = extractCorrelationId(delivery);
  const trigger = baseTrigger("email", binding.id, delivery, clock, { dedupeKey, correlationId });
  if (binding.signalName && correlationId) {
    return { trigger, resumeSignal: { name: binding.signalName, correlationId, payload: delivery.payload } };
  }
  return { trigger };
}

/** fs watch (dev) or upload-endpoint (production) — architecture §6.1. This adapter accepts the already-detected file event (the fs-watch/upload-endpoint mechanics themselves are a deployment-specific wiring concern outside a store-agnostic adapter's scope); its own job is the `Trigger` shape. */
export function adaptFileTrigger(binding: TriggerBinding, filePathOrUrl: string, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("file", binding.id, { payload: { path: filePathOrUrl } }, clock) };
}

/** Consumer adapter for a configured queue — interface-shaped so a real broker adapter (SQS, Redis streams, ...) can be added later without changing the Trigger/Signal contract (architecture §6.1: "ADR-05 explicitly keeps the broker optional"). This session's local/fake backend is an in-process `QueueMessage` shape; a real broker wiring is a documented future extension, not required for v1 per this session's DoD. */
export interface QueueMessage {
  id: string;
  body: unknown;
}
export function adaptQueueTrigger(binding: TriggerBinding, message: QueueMessage, clock: Clock): AdaptedTrigger {
  const correlationId = typeof (message.body as { correlationId?: unknown } | null)?.["correlationId" as never] === "string" ? (message.body as { correlationId: string }).correlationId : undefined;
  const trigger = baseTrigger("queue", binding.id, { payload: message.body }, clock, { dedupeKey: message.id, correlationId });
  if (binding.mode === "resume" && binding.signalName && correlationId) {
    return { trigger, resumeSignal: { name: binding.signalName, correlationId, payload: message.body } };
  }
  return { trigger };
}

/** CDC-style or polling change-table event source — spec/architecture deliberately leave the specific database unnamed (architecture §6.1: "scope is deliberately adapter-interface-only in v1"). Accepts an already-detected change-row event. */
export function adaptDatabaseTrigger(binding: TriggerBinding, changeRow: unknown, clock: Clock): AdaptedTrigger {
  return { trigger: baseTrigger("database", binding.id, { payload: changeRow }, clock) };
}

// ---------------------------------------------------------------------------
// github — real HMAC (shares the webhook mechanism) + real PR-merge-as-
// approval ingestion (this session's DoD names this specifically); other
// event types (pull_request.opened etc.) are interface-complete/fake-backed
// same as the other five in this section.
// ---------------------------------------------------------------------------

export function adaptGithubTrigger(binding: TriggerBinding, delivery: InboundDelivery, secret: string | undefined, clock: Clock): AdapterResult {
  const signatureHeader = headerValue(delivery.headers, binding.webhookSignatureHeader ?? "x-hub-signature-256");
  const rawBody = delivery.rawBody ?? new TextEncoder().encode(JSON.stringify(delivery.payload));
  if (!verifyHmacSignature(rawBody, signatureHeader, secret ?? "")) {
    return { rejected: "bad_hmac" };
  }
  const dedupeKey = headerValue(delivery.headers, "x-github-delivery");
  const trigger = baseTrigger("github", binding.id, delivery, clock, { dedupeKey });
  return { trigger };
}

interface GithubPullRequestMergedPayload {
  action: string;
  pull_request?: { merged?: boolean; number?: number; merged_by?: { login?: string } };
}

/** True when `payload` is a GitHub `pull_request` webhook event reporting an actual merge (`action === "closed" && pull_request.merged === true`) — GitHub's own documented convention for "this PR was merged" (a PR can be closed without merging, which must NOT be treated as an approval decision). */
export function isGithubPrMergeEvent(payload: unknown): payload is GithubPullRequestMergedPayload {
  const p = payload as GithubPullRequestMergedPayload | null;
  return !!p && p.action === "closed" && p.pull_request?.merged === true;
}

/**
 * PR-merge-as-approval ingestion (architecture §7.2, spec §26.2): "a merge
 * event on a tracked PR is ingested as an ApprovalTask decision... reviewer
 * set to the merging GitHub user, going through the exact same ApprovalTask
 * write path as a CLI/dashboard decision." The PR-number → (runId, stepId)
 * mapping is recorded, per architecture, "when the PR-comment report is
 * first posted" — a cross-package concern (S6 owns PR-comment rendering;
 * the actual persisted mapping mechanism isn't specified by either
 * document beyond that one sentence). Rather than inventing an unspecified
 * convention, `resolveApprovalTarget` is this adapter's own documented
 * integration point: the caller supplies how a PR number resolves to a
 * pending ApprovalTask's (runId, stepId) — see SEAMS.md. If it returns
 * undefined (not configured, or this specific PR isn't tracked), this
 * function no-ops and returns undefined rather than guessing.
 */
export async function ingestGithubPrMergeApproval(
  store: AartStore,
  payload: GithubPullRequestMergedPayload,
  clock: Clock,
  resolveApprovalTarget: (payload: GithubPullRequestMergedPayload) => { runId: string; stepId: string } | undefined,
): Promise<ApprovalTask | undefined> {
  const target = resolveApprovalTarget(payload);
  if (!target) return undefined;
  const pending = await store.approvals.list({ runId: target.runId, status: "pending" });
  const task = pending.find((t) => t.stepId === target.stepId);
  if (!task) return undefined;
  const reviewer = payload.pull_request?.merged_by?.login ?? "github";
  const decided: ApprovalTask = {
    ...task,
    status: "approved",
    reviewer,
    decision: { source: "github_pr_merge", prNumber: payload.pull_request?.number },
    decidedAt: clock.nowIso(),
  };
  await store.approvals.put(decided);
  return decided;
}

// ---------------------------------------------------------------------------
// slack — event subscription / slash command, interface-complete/fake-
// backed (this session's DoD).
// ---------------------------------------------------------------------------

export function adaptSlackTrigger(binding: TriggerBinding, delivery: InboundDelivery, secret: string | undefined, clock: Clock): AdapterResult {
  // Slack's own signing-secret scheme (`X-Slack-Signature` over
  // `v0:<timestamp>:<body>`) is provider-specific; this adapter reuses the
  // same generic HMAC-over-rawBody mechanism as webhook/github (a real
  // Slack integration would compute `rawBody` as that provider-specific
  // signed string before calling this) rather than inventing a third
  // verification code path — consistent with this session's DoD framing
  // ("interface-complete with a working local/fake backend for testing").
  const signatureHeader = headerValue(delivery.headers, binding.webhookSignatureHeader ?? "x-slack-signature");
  const rawBody = delivery.rawBody ?? new TextEncoder().encode(JSON.stringify(delivery.payload));
  if (secret && !verifyHmacSignature(rawBody, signatureHeader, secret)) {
    return { rejected: "bad_hmac" };
  }
  return { trigger: baseTrigger("slack", binding.id, delivery, clock) };
}
