// Exercises the real ApprovalTask write path against a real (fs-backed,
// temp-dir) AartStore — architecture §7's F7 fix: "S4 writes ApprovalTask
// rows and standing approvals, and uses the store-homed logger."
import { createFsStore, createLogger, type Logger } from "@aart/store";
import type { StandingApproval } from "@aart/types";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordPrMergeApproval, recordStandingApprovalDecision, workflowVersionApprovalSubject, writeApprovalDecision } from "./approval-tasks.js";

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
