// WaitStore — architecture §5.3 `waits` table, keyed by (run_id, step_id)
// per architecture §5.6. Public audit JSON is kept separate from the complete
// AES-GCM-sealed operational condition. Scheduling and polling open only that
// sealed copy; `resume_at` is deliberately NULL after audit repair so a
// late-discovered secret cannot survive in a query-optimization shadow.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WaitCondition } from "@aart/types";
import type { WaitStore } from "../../../types.js";
import {
  openWaitOperation,
  sealWaitOperation,
} from "../../wait-operation-seal.js";
import { dbAll, dbGet, dbRun, fromJson, toJson, type SqlExec } from "../db.js";

interface WaitRow {
  run_id: string;
  step_id: string;
  wait_condition_json: string;
  signal_match_fingerprint: string | null;
  operational_wait_ciphertext: string | null;
  operational_generation: string | null | undefined;
  created_at: string;
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
  private readonly operationKeyPath: string;

  constructor(
    private readonly exec: SqlExec,
    operationalStateDir: string,
  ) {
    this.operationKeyPath = join(
      operationalStateDir,
      ".wait-operational-key",
    );
  }

  async get(runId: string, stepId: string): Promise<WaitCondition | undefined> {
    const row = await this.exec((db) =>
      dbGet<WaitRow>(db, "SELECT * FROM waits WHERE run_id = ? AND step_id = ?", [runId, stepId]),
    );
    return row ? this.operationalWait(row) : undefined;
  }

  async put(runId: string, stepId: string, wait: WaitCondition, createdAt: string): Promise<void> {
    const operationalGeneration = randomUUID();
    const operationalWait = await sealWaitOperation(
      this.operationKeyPath,
      runId,
      stepId,
      operationalGeneration,
      wait,
    );
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO waits (run_id, step_id, wait_condition_json, signal_match_fingerprint, operational_wait_ciphertext, operational_generation, wait_type, resume_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           wait_condition_json = excluded.wait_condition_json,
           signal_match_fingerprint = excluded.signal_match_fingerprint,
           operational_wait_ciphertext = excluded.operational_wait_ciphertext,
           operational_generation = excluded.operational_generation,
           wait_type = excluded.wait_type,
           resume_at = NULL,
           created_at = excluded.created_at`,
        [
          runId,
          stepId,
          toJson(wait)!,
          fingerprintForWait(wait),
          operationalWait,
          operationalGeneration,
          wait.type,
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
    const stored = await this.exec((db) =>
      dbGet<WaitRow>(
        db,
        "SELECT * FROM waits WHERE run_id = ? AND step_id = ?",
        [runId, stepId],
      ),
    );
    if (!stored) return;
    const priorWait = fromJson<WaitCondition>(
      stored.wait_condition_json,
    )!;
    const openedOperationalWait =
      await this.operationalWait(stored);
    const operationalGeneration =
      stored.operational_generation ?? randomUUID();
    const operationalWait =
      stored.operational_wait_ciphertext ??
      (await sealWaitOperation(
        this.operationKeyPath,
        runId,
        stepId,
        operationalGeneration,
        openedOperationalWait,
      ));
    await this.exec((db) => {
      dbRun(
        db,
        "UPDATE waits SET wait_condition_json = ?, signal_match_fingerprint = ?, operational_wait_ciphertext = ?, operational_generation = ?, resume_at = NULL WHERE run_id = ? AND step_id = ?",
        [
          toJson(wait)!,
          stored.signal_match_fingerprint ??
            fingerprintForWait(priorWait),
          operationalWait,
          operationalGeneration,
          runId,
          stepId,
        ],
      );
    });
  }

  async delete(runId: string, stepId: string): Promise<void> {
    await this.exec((db) => dbRun(db, "DELETE FROM waits WHERE run_id = ? AND step_id = ?", [runId, stepId]));
  }

  async list(filter?: { runId?: string }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    const rows = await this.exec((db) =>
      filter?.runId === undefined
        ? dbAll<WaitRow>(db, "SELECT * FROM waits")
        : dbAll<WaitRow>(
            db,
            "SELECT * FROM waits WHERE run_id = ?",
            [filter.runId],
          ),
    );
    return rows.map((r) => ({ runId: r.run_id, stepId: r.step_id, wait: fromJson<WaitCondition>(r.wait_condition_json)!, createdAt: r.created_at }));
  }

  async listOperational(filter?: {
    runId?: string;
    type?: WaitCondition["type"];
  }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter?.type !== undefined) {
      clauses.push("wait_type = ?");
      params.push(filter.type);
    }
    const where =
      clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = await this.exec((db) =>
      dbAll<WaitRow>(
        db,
        `SELECT * FROM waits${where}`,
        params,
      ),
    );
    return Promise.all(
      rows.map(async (row) => ({
        runId: row.run_id,
        stepId: row.step_id,
        wait: await this.operationalWait(row),
        createdAt: row.created_at,
      })),
    );
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
      dbAll<WaitRow>(
        db,
        "SELECT * FROM waits WHERE wait_type = 'timer'",
      ),
    );
    const due: Array<{
      runId: string;
      stepId: string;
      wait: WaitCondition;
    }> = [];
    for (const row of rows) {
      const operational = await this.operationalWait(row);
      if (
        operational.type === "timer" &&
        operational.resumeAt <= now
      ) {
        due.push({
          runId: row.run_id,
          stepId: row.step_id,
          wait: fromJson<WaitCondition>(
            row.wait_condition_json,
          )!,
        });
      }
    }
    return due;
  }

  private async operationalWait(row: WaitRow): Promise<WaitCondition> {
    if (row.operational_wait_ciphertext === null) {
      return fromJson<WaitCondition>(row.wait_condition_json)!;
    }
    const wait = await openWaitOperation(
      this.operationKeyPath,
      row.run_id,
      row.step_id,
      row.operational_generation ?? undefined,
      row.operational_wait_ciphertext,
    );
    if (
      row.operational_generation === null ||
      row.operational_generation === undefined
    ) {
      const operationalGeneration = randomUUID();
      const operationalWait = await sealWaitOperation(
        this.operationKeyPath,
        row.run_id,
        row.step_id,
        operationalGeneration,
        wait,
      );
      await this.exec((db) =>
        dbRun(
          db,
          `UPDATE waits
           SET operational_wait_ciphertext = ?,
               operational_generation = ?
           WHERE run_id = ? AND step_id = ?
             AND operational_generation IS NULL`,
          [
            operationalWait,
            operationalGeneration,
            row.run_id,
            row.step_id,
          ],
        ),
      );
      row.operational_wait_ciphertext = operationalWait;
      row.operational_generation = operationalGeneration;
    }
    return wait;
  }
}
