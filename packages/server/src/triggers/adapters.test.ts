// One test per trigger type (architecture §6.1's 13-row table), plus
// PR-merge-as-approval ingestion. manual/cli/mcp/sdk/webhook/schedule/poll
// are exercised as fully real; email/file/queue/database/github/slack are
// exercised against this session's local/fake backend, per this session's
// DoD's explicit tiering.
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalTask } from "@aart/types";
import { computeHmacSignature } from "./hmac.js";
import {
  adaptCliTrigger,
  adaptDatabaseTrigger,
  adaptEmailTrigger,
  adaptFileTrigger,
  adaptGithubTrigger,
  adaptManualTrigger,
  adaptMcpTrigger,
  adaptPollFire,
  adaptQueueTrigger,
  adaptScheduleFire,
  adaptSdkTrigger,
  adaptSlackTrigger,
  adaptWebhookTrigger,
  ingestGithubPrMergeApproval,
  isGithubPrMergeEvent,
} from "./adapters.js";
import { createFakeClock, createTestFixture, type TestFixture } from "../test-helpers.js";
import type { TriggerBinding } from "./types.js";

let fx: TestFixture | undefined;
afterEach(async () => {
  await fx?.cleanup();
  fx = undefined;
});

function binding(overrides: Partial<TriggerBinding> = {}): TriggerBinding {
  return { id: "b1", type: "manual", workflowId: "wf", mode: "start", ...overrides };
}

const clock = createFakeClock("2026-07-10T00:00:00.000Z");

describe("fully-real adapters (this session's DoD)", () => {
  it("manual", () => {
    const { trigger } = adaptManualTrigger(binding(), { payload: { url: "http://x" } }, clock);
    expect(trigger.type).toBe("manual");
    expect(trigger.payload).toEqual({ url: "http://x" });
  });

  it("cli", () => {
    const { trigger } = adaptCliTrigger(binding(), { payload: { workflowId: "wf" } }, clock);
    expect(trigger.type).toBe("cli");
  });

  it("mcp", () => {
    const { trigger } = adaptMcpTrigger(binding(), { payload: {} }, clock);
    expect(trigger.type).toBe("mcp");
  });

  it("sdk", () => {
    const { trigger } = adaptSdkTrigger(binding(), { payload: { event: "listing.submitted" } }, clock);
    expect(trigger.type).toBe("sdk");
  });

  it("webhook — valid HMAC produces a Trigger", () => {
    const secret = "webhook-secret";
    const payload = { file_url: "https://x/bill.pdf" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const sig = computeHmacSignature(rawBody, secret);
    const result = adaptWebhookTrigger(binding({ type: "webhook" }), { payload, rawBody, headers: { "x-aart-signature": sig } }, secret, clock);
    expect("rejected" in result).toBe(false);
    if (!("rejected" in result)) expect(result.trigger.type).toBe("webhook");
  });

  it("webhook — invalid HMAC is rejected, never reaching Trigger construction (architecture §6.1/§15)", () => {
    const payload = { file_url: "https://x/bill.pdf" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const result = adaptWebhookTrigger(binding({ type: "webhook" }), { payload, rawBody, headers: { "x-aart-signature": "sha256=deadbeef" } }, "webhook-secret", clock);
    expect(result).toEqual({ rejected: "bad_hmac" });
  });

  it("webhook — a resume-mode binding with a matching correlationId synthesizes a resumeSignal", () => {
    const secret = "s";
    const payload = { correlationId: "corr-1", value: 42 };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const sig = computeHmacSignature(rawBody, secret);
    const result = adaptWebhookTrigger(binding({ type: "webhook", mode: "resume", signalName: "quote.received" }), { payload, rawBody, headers: { "x-aart-signature": sig } }, secret, clock);
    expect("rejected" in result).toBe(false);
    if (!("rejected" in result)) {
      expect(result.resumeSignal).toEqual({ name: "quote.received", correlationId: "corr-1", payload });
    }
  });

  it("schedule — adapts a fired Schedule row into a Trigger (architecture §29/§6.1)", () => {
    const schedule = { id: "sched_1", workflowId: "wf", workflowVersion: "1", cron: "0 9 * * 1", timezone: "UTC", missedRunPolicy: "fire_once" as const, paused: false, inputs: { brokerId: "b1" } };
    const { trigger } = adaptScheduleFire(schedule, "2026-07-13T09:00:00.000Z", clock);
    expect(trigger.type).toBe("schedule");
    expect(trigger.payload).toMatchObject({ scheduleId: "sched_1", firedAt: "2026-07-13T09:00:00.000Z", inputs: { brokerId: "b1" } });
  });

  it("poll — adapts a poll response that already satisfied the condition into a Trigger", () => {
    const { trigger } = adaptPollFire(binding({ type: "poll" }), { rate: 0.42 }, clock);
    expect(trigger.type).toBe("poll");
    expect(trigger.payload).toEqual({ rate: 0.42 });
  });
});

describe("interface-complete / local-fake-backed adapters (this session's DoD)", () => {
  it("email — converted to a Signal-producing resume trigger per spec §13.3 ('email replies are Signals')", () => {
    const delivery = { payload: { body: "approved" }, headers: { "message-id": "<msg-1@example.com>" } };
    const { trigger, resumeSignal } = adaptEmailTrigger(binding({ type: "email", mode: "resume", signalName: "email.reply" }), delivery, clock, () => "thread-corr-1");
    expect(trigger.type).toBe("email");
    expect(trigger.dedupeKey).toBe("<msg-1@example.com>");
    expect(resumeSignal).toEqual({ name: "email.reply", correlationId: "thread-corr-1", payload: { body: "approved" } });
  });

  it("file — fs watch / upload-endpoint event", () => {
    const { trigger } = adaptFileTrigger(binding({ type: "file" }), "/uploads/bill.pdf", clock);
    expect(trigger.type).toBe("file");
    expect(trigger.payload).toEqual({ path: "/uploads/bill.pdf" });
  });

  it("queue — local/fake message backend, dedupeKey from the message's own id", () => {
    const { trigger } = adaptQueueTrigger(binding({ type: "queue" }), { id: "msg-99", body: { orderId: "o1" } }, clock);
    expect(trigger.type).toBe("queue");
    expect(trigger.dedupeKey).toBe("msg-99");
  });

  it("database — adapter-interface-only per architecture §6.1 ('no specific database is wired')", () => {
    const { trigger } = adaptDatabaseTrigger(binding({ type: "database" }), { table: "listings", op: "insert", row: { id: 1 } }, clock);
    expect(trigger.type).toBe("database");
  });

  it("github — valid HMAC (X-Hub-Signature-256 convention) produces a Trigger with dedupeKey from X-GitHub-Delivery", () => {
    const secret = "gh-secret";
    const payload = { action: "opened" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const sig = computeHmacSignature(rawBody, secret);
    const result = adaptGithubTrigger(binding({ type: "github" }), { payload, rawBody, headers: { "x-hub-signature-256": sig, "x-github-delivery": "gh-delivery-1" } }, secret, clock);
    expect("rejected" in result).toBe(false);
    if (!("rejected" in result)) {
      expect(result.trigger.type).toBe("github");
      expect(result.trigger.dedupeKey).toBe("gh-delivery-1");
    }
  });

  it("github — invalid HMAC rejected", () => {
    const payload = { action: "opened" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const result = adaptGithubTrigger(binding({ type: "github" }), { payload, rawBody, headers: { "x-hub-signature-256": "sha256=bad" } }, "gh-secret", clock);
    expect(result).toEqual({ rejected: "bad_hmac" });
  });

  it("slack — HMAC-verified when a secret is configured", () => {
    const secret = "slack-secret";
    const payload = { type: "event_callback" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const sig = computeHmacSignature(rawBody, secret);
    const result = adaptSlackTrigger(binding({ type: "slack" }), { payload, rawBody, headers: { "x-slack-signature": sig } }, secret, clock);
    expect("rejected" in result).toBe(false);
  });

  it("slack — rejects an invalid signature when a secret IS configured", () => {
    const payload = { type: "event_callback" };
    const rawBody = new TextEncoder().encode(JSON.stringify(payload));
    const result = adaptSlackTrigger(binding({ type: "slack" }), { payload, rawBody, headers: { "x-slack-signature": "sha256=bad" } }, "slack-secret", clock);
    expect(result).toEqual({ rejected: "bad_hmac" });
  });
});

describe("github PR-merge-as-approval ingestion (architecture §7.2, spec §26.2)", () => {
  it("isGithubPrMergeEvent is true only for an actually-merged, closed PR", () => {
    expect(isGithubPrMergeEvent({ action: "closed", pull_request: { merged: true } })).toBe(true);
    expect(isGithubPrMergeEvent({ action: "closed", pull_request: { merged: false } })).toBe(false); // closed without merging
    expect(isGithubPrMergeEvent({ action: "opened", pull_request: { merged: false } })).toBe(false);
  });

  it("writes an ApprovalTask decision with the merging user as reviewer, through the same write path as any decision", async () => {
    fx = await createTestFixture(clock);
    const pending: ApprovalTask = { id: "at_1", runId: "run_1", stepId: "approve_release", title: "Approve", description: "d", status: "pending", createdAt: clock.nowIso() };
    await fx.store.approvals.put(pending);

    const payload = { action: "closed", pull_request: { number: 42, merged: true, merged_by: { login: "octocat" } } };
    const decided = await ingestGithubPrMergeApproval(fx.store, payload, clock, () => ({ runId: "run_1", stepId: "approve_release" }));

    expect(decided?.status).toBe("approved");
    expect(decided?.reviewer).toBe("octocat");
    expect(decided?.decidedAt).toBe(clock.nowIso());

    const persisted = await fx.store.approvals.get("at_1");
    expect(persisted?.status).toBe("approved");
    expect(persisted?.reviewer).toBe("octocat");
  });

  it("no-ops (returns undefined) when resolveApprovalTarget doesn't recognize this PR, rather than guessing", async () => {
    fx = await createTestFixture(clock);
    const payload = { action: "closed", pull_request: { number: 999, merged: true } };
    const decided = await ingestGithubPrMergeApproval(fx.store, payload, clock, () => undefined);
    expect(decided).toBeUndefined();
  });

  it("no-ops when the resolved target has no PENDING approval task (already decided, or never existed)", async () => {
    fx = await createTestFixture(clock);
    const decided = await ingestGithubPrMergeApproval(fx.store, { action: "closed", pull_request: { merged: true } }, clock, () => ({ runId: "run_missing", stepId: "x" }));
    expect(decided).toBeUndefined();
  });
});
