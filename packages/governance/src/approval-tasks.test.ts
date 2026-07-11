// Exercises the real ApprovalTask write path against a real (fs-backed,
// temp-dir) AartStore — architecture §7's F7 fix: "S4 writes ApprovalTask
// rows and standing approvals, and uses the store-homed logger."
import { createFsStore, createLogger, type Logger } from "@aart/store";
import type { StandingApproval } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeWorkflowVersionApprovalSubject, recordPrMergeApproval, recordStandingApprovalDecision, workflowVersionApprovalSubject, writeApprovalDecision } from "./approval-tasks.js";

let root: string;
let store: ReturnType<typeof createFsStore>;
let logger: Logger;
let loggedLines: unknown[];

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "aart-governance-approvals-"));
  store = createFsStore(root);
  loggedLines = [];
  logger = createLogger({ sink: (line) => loggedLines.push(line) });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("writeApprovalDecision — the normal approval-write path, against a real store", () => {
  it("persists an ApprovalTask row retrievable via store.approvals", async () => {
    const task = await writeApprovalDecision(
      store,
      {
        id: "approval_1",
        runId: "run_1",
        stepId: "review_extraction",
        title: "Review extracted bill fields",
        description: "d",
        status: "approved",
        reviewer: "jane@example.com",
        createdAt: "2026-07-10T00:00:00.000Z",
        decidedAt: "2026-07-10T00:05:00.000Z",
      },
      logger,
    );
    expect(task.status).toBe("approved");
    const stored = await store.approvals.get("approval_1");
    expect(stored).toEqual(task);
  });

  it("routes through the redaction chokepoint before persisting — architecture §7.9's diagram names 'approval decision' as a redactRecord input path", async () => {
    const secret = "sk-live-approval-secret-value";
    const task = await writeApprovalDecision(
      store,
      {
        id: "approval_with_secret",
        runId: "run_3",
        stepId: "s1",
        title: "t",
        description: "d",
        status: "approved",
        decision: { echoedValue: `the resolved value was ${secret}` },
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      logger,
      new Set([secret]),
    );
    expect(JSON.stringify(task)).not.toContain(secret);
    expect((task.decision as { echoedValue: string }).echoedValue).toContain("[REDACTED:secret-1]");
    const stored = await store.approvals.get("approval_with_secret");
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("is a documented no-op when no resolvedSecretRefs are supplied (the default) — nothing is altered", async () => {
    const task = await writeApprovalDecision(
      store,
      {
        id: "approval_no_secrets",
        runId: "run_4",
        stepId: "s1",
        title: "plain title",
        description: "plain description",
        status: "approved",
        decision: { note: "nothing sensitive here" },
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      logger,
    );
    expect(task.title).toBe("plain title");
    expect((task.decision as { note: string }).note).toBe("nothing sensitive here");
  });

  it("uses the store-homed logger (F7) — a log line is emitted through the injected Logger, not console.log", async () => {
    await writeApprovalDecision(
      store,
      {
        id: "approval_2",
        runId: "run_2",
        stepId: "s1",
        title: "t",
        description: "d",
        status: "rejected",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
      logger,
    );
    expect(loggedLines.length).toBeGreaterThan(0);
    expect(loggedLines[0]).toMatchObject({ runId: "run_2", stepId: "s1", status: "rejected" });
  });
});

describe("recordPrMergeApproval — PR-merge-as-decision write path (architecture §7.2, spec §26.2)", () => {
  it("writes an ApprovalTask with reviewer = the merging user, via a synthetic merge-event payload", async () => {
    const task = await recordPrMergeApproval(store, {
      workflowId: "checkout-smoke",
      workflowVersion: "0.2.0",
      mergedBy: "octocat",
      mergedAt: "2026-07-10T12:00:00.000Z",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/repo/pull/42",
    });
    expect(task.status).toBe("approved");
    expect(task.reviewer).toBe("octocat");
    expect(task.decision).toMatchObject({ source: "github_pr_merge", pullRequestNumber: 42 });

    const subject = workflowVersionApprovalSubject("checkout-smoke", "0.2.0");
    expect(task.runId).toBe(subject.runId);
    expect(task.stepId).toBe(subject.stepId);

    const stored = await store.approvals.get(task.id);
    expect(stored?.reviewer).toBe("octocat");
  });

  it("goes through the exact same store.approvals.put path as a CLI/dashboard decision (writeApprovalDecision)", async () => {
    const merge = await recordPrMergeApproval(store, {
      workflowId: "wf",
      workflowVersion: "1.0.0",
      mergedBy: "alice",
      mergedAt: "2026-07-10T00:00:00.000Z",
      pullRequestNumber: 7,
    });
    const manual = await writeApprovalDecision(store, {
      id: "manual_1",
      runId: "run_manual",
      stepId: "s",
      title: "t",
      description: "d",
      status: "approved",
      reviewer: "bob",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    const all = await store.approvals.list();
    expect(all.map((t) => t.id).sort()).toEqual([manual.id, merge.id].sort());
  });
});

describe("workflowVersionApprovalSubject / decodeWorkflowVersionApprovalSubject — gate-parameterized sentinel (S14 'gate write paths')", () => {
  it("defaults to the humanReview gate when none is given — this sentinel's pre-S14 sole behavior, unchanged", () => {
    const subject = workflowVersionApprovalSubject("wf-a", "1.0.0");
    expect(subject.stepId).toBe("__gate:humanReview__");
    expect(subject.runId).toBe("workflow-version:wf-a@1.0.0");
  });

  it("encodes an explicit riskReview gate into stepId — no new mechanism, the same sentinel shape with a different gate key", () => {
    const subject = workflowVersionApprovalSubject("wf-a", "1.0.0", "riskReview");
    expect(subject.stepId).toBe("__gate:riskReview__");
    expect(subject.runId).toBe("workflow-version:wf-a@1.0.0");
  });

  it("decodes a riskReview-shaped stepId back to gate: 'riskReview'", () => {
    const subject = workflowVersionApprovalSubject("wf-b", "2.0.0", "riskReview");
    expect(decodeWorkflowVersionApprovalSubject(subject.runId, subject.stepId)).toEqual({ workflowId: "wf-b", workflowVersion: "2.0.0", gate: "riskReview" });
  });

  it("decodes with stepId omitted (every pre-S14 call site, e.g. the dashboard's single-arg decode call) as gate: 'humanReview'", () => {
    const subject = workflowVersionApprovalSubject("wf-c", "3.0.0");
    expect(decodeWorkflowVersionApprovalSubject(subject.runId)).toEqual({ workflowId: "wf-c", workflowVersion: "3.0.0", gate: "humanReview" });
  });

  it("decodes an unrecognized/malformed stepId as gate: 'humanReview' rather than throwing (safe fallback, not a crash)", () => {
    const subject = workflowVersionApprovalSubject("wf-d", "4.0.0");
    expect(decodeWorkflowVersionApprovalSubject(subject.runId, "not-a-gate-shaped-step")).toEqual({ workflowId: "wf-d", workflowVersion: "4.0.0", gate: "humanReview" });
  });

  it("still returns undefined for a non-sentinel (genuine per-run) runId regardless of stepId — never a false positive", () => {
    expect(decodeWorkflowVersionApprovalSubject("run-genuine-1", "__gate:riskReview__")).toBeUndefined();
  });
});

describe("recordStandingApprovalDecision — synthetic ApprovalTask with audit trail (architecture §7.5, spec §17.6)", () => {
  const standingApproval: StandingApproval = {
    id: "sa_low_risk",
    maxRiskTier: "Low-medium",
    capabilities: ["file.read"],
    grantedBy: "ops-lead@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  it("records which standing approval matched in the decision's audit trail", async () => {
    const task = await recordStandingApprovalDecision(store, {
      workflowId: "daily-report",
      workflowVersion: "1.0.0",
      standingApproval,
      now: "2026-07-10T00:00:00.000Z",
    });
    expect(task.status).toBe("approved");
    expect(task.reviewer).toBe("ops-lead@example.com");
    expect(task.decision).toMatchObject({ source: "standing_approval", standingApprovalId: "sa_low_risk", grantedBy: "ops-lead@example.com" });
  });

  it("is recorded with the same visibility as a regular decision — queryable via store.approvals.list", async () => {
    await recordStandingApprovalDecision(store, {
      workflowId: "daily-report",
      workflowVersion: "1.0.0",
      standingApproval,
      now: "2026-07-10T00:00:00.000Z",
    });
    const all = await store.approvals.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.decision).toMatchObject({ source: "standing_approval" });
  });
});
