// RunStore — architecture §5.3 `runs` table + `run_dedupe_keys` (the
// exactly-once resume dedupe ledger, architecture §4.4.2). See schema.ts's
// module doc comment for why trace/waits/artifacts are stored as columns
// on `runs` directly rather than architecture's literal separate
// `step_traces` table.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunFlag, RunRecord, RunStatus } from "@aart/types";
import type {
  RunOperationalState,
  RunStore,
} from "../../../types.js";
import {
  openOperationalState,
  sealOperationalState,
} from "../../operational-state-seal.js";
import { dbAll, dbGet, dbRun, fromBool, fromJson, toBool, toJson, type SqlExec } from "../db.js";

interface RunRow {
  run_id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  approved: number;
  approval_mode: string;
  trigger_json: string;
  inputs_json: string;
  secret_tainted_input_paths_json: string | null;
  secret_tainted_trigger_paths_json: string | null;
  params_json: string | null;
  trace_json: string;
  waits_json: string;
  outputs_json: string | null;
  error: string | null;
  artifacts_json: string;
  snapshot_json: string;
  flag_json: string | null;
  schema_version: number;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  operational_generation: string | null | undefined;
  operational_run_state_ciphertext: string | null | undefined;
}

function rowToRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status as RunStatus,
    approved: fromBool(row.approved),
    approvalMode: row.approval_mode as RunRecord["approvalMode"],
    trigger: fromJson(row.trigger_json)!,
    inputs: fromJson(row.inputs_json)!,
    ...(row.secret_tainted_input_paths_json !== null
      ? {
          secretTaintedInputPaths: fromJson<string[]>(
            row.secret_tainted_input_paths_json,
          )!,
        }
      : {}),
    ...(row.secret_tainted_trigger_paths_json !== null
      ? {
          secretTaintedTriggerPaths: fromJson<string[]>(
            row.secret_tainted_trigger_paths_json,
          )!,
        }
      : {}),
    params: fromJson(row.params_json),
    trace: fromJson(row.trace_json)!,
    waits: fromJson(row.waits_json)!,
    outputs: fromJson(row.outputs_json),
    error: row.error ?? undefined,
    artifacts: fromJson(row.artifacts_json)!,
    snapshot: fromJson(row.snapshot_json)!,
    flag: row.flag_json === null ? undefined : fromJson<RunFlag>(row.flag_json),
    schemaVersion: row.schema_version,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
  };
}

export class SqliteRunStore implements RunStore {
  private readonly operationKeyPath: string;

  constructor(
    private readonly exec: SqlExec,
    operationalStateDir: string,
  ) {
    this.operationKeyPath = join(
      operationalStateDir,
      ".run-operational-key",
    );
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const row = await this.exec((db) => dbGet<RunRow>(db, "SELECT * FROM runs WHERE run_id = ?", [runId]));
    return row ? rowToRun(row) : undefined;
  }

  async put(run: RunRecord): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO runs (run_id, workflow_id, workflow_version, status, approved, approval_mode, trigger_json, inputs_json, secret_tainted_input_paths_json, secret_tainted_trigger_paths_json, params_json, trace_json, waits_json, outputs_json, error, artifacts_json, snapshot_json, flag_json, schema_version, started_at, updated_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           workflow_id = excluded.workflow_id,
           workflow_version = excluded.workflow_version,
           status = excluded.status,
           approved = excluded.approved,
           approval_mode = excluded.approval_mode,
           trigger_json = excluded.trigger_json,
           inputs_json = excluded.inputs_json,
           secret_tainted_input_paths_json = excluded.secret_tainted_input_paths_json,
           secret_tainted_trigger_paths_json = excluded.secret_tainted_trigger_paths_json,
           params_json = excluded.params_json,
           trace_json = excluded.trace_json,
           waits_json = excluded.waits_json,
           outputs_json = excluded.outputs_json,
           error = excluded.error,
           artifacts_json = excluded.artifacts_json,
           snapshot_json = excluded.snapshot_json,
           flag_json = excluded.flag_json,
           schema_version = excluded.schema_version,
           started_at = excluded.started_at,
           updated_at = excluded.updated_at,
           ended_at = excluded.ended_at`,
        [
          run.runId,
          run.workflowId,
          run.workflowVersion,
          run.status,
          toBool(run.approved),
          run.approvalMode,
          toJson(run.trigger)!,
          toJson(run.inputs)!,
          toJson(run.secretTaintedInputPaths),
          toJson(run.secretTaintedTriggerPaths),
          toJson(run.params),
          toJson(run.trace)!,
          toJson(run.waits)!,
          toJson(run.outputs),
          run.error ?? null,
          toJson(run.artifacts)!,
          toJson(run.snapshot)!,
          // `flag` is `RunFlag | null | undefined` on the frozen type — both
          // "never flagged" (undefined) and "explicitly absent" (null)
          // collapse to SQL NULL; the distinction isn't meaningful (architecture
          // §4.1: "flag is absent/null for every other run").
          run.flag ? toJson(run.flag) : null,
          run.schemaVersion,
          run.startedAt,
          run.updatedAt,
          run.endedAt ?? null,
        ],
      ),
    );
  }

  async list(filter?: { status?: RunStatus; workflowId?: string }): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<RunRow>(db, `SELECT * FROM runs${where}`, params));
    return rows.map(rowToRun);
  }

  async getOperationalState(
    runId: string,
  ): Promise<RunOperationalState | undefined> {
    const row = await this.exec((db) =>
      dbGet<RunRow>(
        db,
        "SELECT * FROM runs WHERE run_id = ?",
        [runId],
      ),
    );
    if (
      row?.operational_generation === null ||
      row?.operational_generation === undefined ||
      row.operational_run_state_ciphertext === null ||
      row.operational_run_state_ciphertext === undefined
    ) {
      return undefined;
    }
    return openOperationalState<RunOperationalState>(
      this.operationKeyPath,
      [runId, row.operational_generation, "active-run-state"],
      row.operational_run_state_ciphertext,
    );
  }

  async putOperationalState(
    runId: string,
    state: RunOperationalState,
  ): Promise<void> {
    const generation = randomUUID();
    const ciphertext = await sealOperationalState(
      this.operationKeyPath,
      [runId, generation, "active-run-state"],
      state,
    );
    const changed = await this.exec((db) =>
      dbRun(
        db,
        `UPDATE runs
         SET operational_generation = ?,
             operational_run_state_ciphertext = ?
         WHERE run_id = ?`,
        [generation, ciphertext, runId],
      ),
    );
    if (changed.changes === 0) {
      throw new Error(
        `putOperationalState: no run ${runId} exists.`,
      );
    }
  }

  async replaceOperationalState(
    runId: string,
    state: RunOperationalState,
  ): Promise<void> {
    const existing = await this.exec((db) =>
      dbGet<{ found: number }>(
        db,
        `SELECT 1 AS found FROM runs
         WHERE run_id = ?
           AND operational_run_state_ciphertext IS NOT NULL`,
        [runId],
      ),
    );
    if (existing === undefined) return;
    await this.putOperationalState(runId, state);
  }

  async deleteOperationalState(runId: string): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE runs
         SET operational_generation = NULL,
             operational_run_state_ciphertext = NULL
         WHERE run_id = ?`,
        [runId],
      ),
    );
  }

  async hasDedupeKey(runId: string, dedupeKey: string): Promise<boolean> {
    const row = await this.exec((db) =>
      dbGet(db, "SELECT 1 as found FROM run_dedupe_keys WHERE run_id = ? AND dedupe_key = ?", [runId, dedupeKey]),
    );
    return row !== undefined;
  }

  async recordDedupeKey(runId: string, dedupeKey: string): Promise<void> {
    await this.exec((db) => {
      const existing = dbGet(db, "SELECT 1 as found FROM runs WHERE run_id = ?", [runId]);
      if (!existing) {
        throw new Error(`recordDedupeKey: no run ${runId} exists to attach a dedupe key to — put() the RunRecord first.`);
      }
      return dbRun(db, "INSERT OR IGNORE INTO run_dedupe_keys (run_id, dedupe_key) VALUES (?, ?)", [runId, dedupeKey]);
    });
  }
}
