// WaitStore — architecture §5.3 `waits` table, keyed by (run_id, step_id)
// per architecture §5.6. `wait_type`/`resume_at` are extracted columns
// purely so `listDue` can filter in SQL rather than loading every
// outstanding wait into JS on every scheduler-ticker interval (architecture
// §4.4.3 — S2 runs this on a 5s-10s tick; a table-scan-and-JSON-parse-
// everything approach would scale badly as outstanding waits accumulate).
import { createHash } from "node:crypto";
import type { WaitCondition } from "@aart/types";
import type { WaitStore } from "../../../types.js";
import { dbAll, dbGet, dbRun, fromJson, toJson, type SqlExec } from "../db.js";

interface WaitRow {
  run_id: string;
  step_id: string;
  wait_condition_json: string;
  signal_match_fingerprint: string | null;
  created_at: string;
}

function resumeAtFor(wait: WaitCondition): string | null {
  return wait.type === "timer" ? wait.resumeAt : null;
}

function signalCorrelation(
  wait: WaitCondition,
): { name: string; correlationId: string } | undefined {
  switch (wait.type) {
    case "signal":
      return { name: wait.name, correlationId: wait.correlationId };
    case "webhook":
      return { name: wait.event, correlationId: wait.correlationId };
    case "queue":
      return { name: wait.queue, correlationId: wait.correlationId };
    case "external_job":
      return { name: wait.provider, correlationId: wait.jobId };
    case "approval":
    case "timer":
    case "manual":
      return undefined;
  }
}

function signalMatchFingerprint(
  name: string,
  correlationId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([name, correlationId]))
    .digest("hex");
}

function fingerprintForWait(wait: WaitCondition): string | null {
  const correlation = signalCorrelation(wait);
  return correlation
    ? signalMatchFingerprint(correlation.name, correlation.correlationId)
    : null;
}

export class SqliteWaitStore implements WaitStore {
  constructor(private readonly exec: SqlExec) {}

  async get(runId: string, stepId: string): Promise<WaitCondition | undefined> {
    const row = await this.exec((db) =>
      dbGet<WaitRow>(db, "SELECT * FROM waits WHERE run_id = ? AND step_id = ?", [runId, stepId]),
    );
    return row ? fromJson<WaitCondition>(row.wait_condition_json) : undefined;
  }

  async put(runId: string, stepId: string, wait: WaitCondition, createdAt: string): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO waits (run_id, step_id, wait_condition_json, signal_match_fingerprint, wait_type, resume_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           wait_condition_json = excluded.wait_condition_json,
           signal_match_fingerprint = excluded.signal_match_fingerprint,
           wait_type = excluded.wait_type,
           resume_at = excluded.resume_at,
           created_at = excluded.created_at`,
        [
          runId,
          stepId,
          toJson(wait)!,
          fingerprintForWait(wait),
          wait.type,
          resumeAtFor(wait),
          createdAt,
        ],
      ),
    );
  }

  async redactAudit(
    runId: string,
    stepId: string,
    wait: WaitCondition,
  ): Promise<void> {
    await this.exec((db) => {
      const stored = dbGet<WaitRow>(
        db,
        "SELECT * FROM waits WHERE run_id = ? AND step_id = ?",
        [runId, stepId],
      );
      if (!stored) return;
      const priorWait = fromJson<WaitCondition>(
        stored.wait_condition_json,
      )!;
      dbRun(
        db,
        "UPDATE waits SET wait_condition_json = ?, signal_match_fingerprint = ? WHERE run_id = ? AND step_id = ?",
        [
          toJson(wait)!,
          stored.signal_match_fingerprint ??
            fingerprintForWait(priorWait),
          runId,
          stepId,
        ],
      );
    });
  }

  async delete(runId: string, stepId: string): Promise<void> {
    await this.exec((db) => dbRun(db, "DELETE FROM waits WHERE run_id = ? AND step_id = ?", [runId, stepId]));
  }

  async list(): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    const rows = await this.exec((db) => dbAll<WaitRow>(db, "SELECT * FROM waits"));
    return rows.map((r) => ({ runId: r.run_id, stepId: r.step_id, wait: fromJson<WaitCondition>(r.wait_condition_json)!, createdAt: r.created_at }));
  }

  async findSignalMatches(
    name: string,
    correlationId: string,
  ): Promise<Array<{ runId: string; stepId: string }>> {
    const expected = signalMatchFingerprint(name, correlationId);
    const rows = await this.exec((db) =>
      dbAll<WaitRow>(
        db,
        "SELECT * FROM waits WHERE signal_match_fingerprint = ? OR signal_match_fingerprint IS NULL",
        [expected],
      ),
    );
    return rows
      .filter((row) => {
        if (row.signal_match_fingerprint !== null) return true;
        return (
          fingerprintForWait(
            fromJson<WaitCondition>(row.wait_condition_json)!,
          ) === expected
        );
      })
      .map((row) => ({ runId: row.run_id, stepId: row.step_id }));
  }

  async listDue(now: string): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>> {
    // Same scope as the fs adapter's listDue (adapters/fs/waits.ts): only
    // `timer` waits are determinable purely from WaitCondition's own frozen
    // shape. Poll-mode `external_job` waits additionally need the
    // originating trigger/poll config to know their condition/interval —
    // S2's scheduler ticker (packages/server) cross-references that
    // separately, not buildable from the store layer alone.
    const rows = await this.exec((db) =>
      dbAll<WaitRow>(db, "SELECT * FROM waits WHERE wait_type = 'timer' AND resume_at <= ?", [now]),
    );
    return rows.map((row) => ({
      runId: row.run_id,
      stepId: row.step_id,
      wait: fromJson<WaitCondition>(row.wait_condition_json)!,
    }));
  }
}
