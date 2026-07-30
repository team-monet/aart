// SignalStore — architecture §5.3 `signals` table. Writes participate in the
// real SQLite transaction opened by `transact()`. The filesystem adapter now
// provides the same logical atomicity through its durable redo journal (A76);
// SQLite's native BEGIN/COMMIT remains the multi-process authority.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Signal } from "@aart/types";
import type { SignalStore } from "../../../types.js";
import {
  openOperationalState,
  sealOperationalState,
} from "../../operational-state-seal.js";
import { dbAll, dbGet, dbRun, type SqlExec } from "../db.js";

interface SignalRow {
  signal_id: string;
  name: string;
  correlation_id: string;
  payload_json: string;
  received_at: string;
  consumed_at: string | null;
  consumed_by_run_id: string | null;
  consumed_by_step_id: string | null;
  signal_match_fingerprint: string | null | undefined;
  operational_signal_ciphertext: string | null | undefined;
  operational_generation: string | null | undefined;
}

interface OperationalSignalState {
  signal: Signal;
  resolvedSecretValues: string[];
}

function rowToSignal(row: SignalRow): Signal {
  return {
    id: row.signal_id,
    name: row.name,
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload_json) as unknown,
    receivedAt: row.received_at,
  };
}

export class SqliteSignalStore implements SignalStore {
  private readonly operationKeyPath: string;

  constructor(
    private readonly exec: SqlExec,
    operationalStateDir: string,
  ) {
    this.operationKeyPath = join(
      operationalStateDir,
      ".signal-operational-key",
    );
  }

  private fingerprint(name: string, correlationId: string): string {
    return createHash("sha256")
      .update(JSON.stringify([name, correlationId]))
      .digest("hex");
  }

  async append(signal: Signal): Promise<void> {
    const operationalGeneration = randomUUID();
    const operationalSignal = await sealOperationalState(
      this.operationKeyPath,
      [signal.id, operationalGeneration, "signal"],
      { signal, resolvedSecretValues: [] },
    );
    await this.exec((db) =>
      dbRun(
        db,
        "INSERT INTO signals (signal_id, name, correlation_id, payload_json, received_at, consumed_at, consumed_by_run_id, consumed_by_step_id, signal_match_fingerprint, operational_signal_ciphertext, operational_generation) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
        [
          signal.id,
          signal.name,
          signal.correlationId,
          JSON.stringify(signal.payload),
          signal.receivedAt,
          this.fingerprint(signal.name, signal.correlationId),
          operationalSignal,
          operationalGeneration,
        ],
      ),
    );
  }

  async findUnconsumedMatch(name: string, correlationId: string): Promise<Signal | undefined> {
    const expected = this.fingerprint(name, correlationId);
    const rows = await this.exec((db) =>
      dbAll<SignalRow>(
        db,
        `SELECT * FROM signals
         WHERE consumed_at IS NULL
           AND (signal_match_fingerprint = ? OR signal_match_fingerprint IS NULL)
         ORDER BY received_at ASC`,
        [expected],
      ),
    );
    const row = rows.find(
      (candidate) =>
        candidate.signal_match_fingerprint === expected ||
        (candidate.name === name &&
          candidate.correlation_id === correlationId),
    );
    return row ? this.operationalSignal(row) : undefined;
  }

  async markConsumed(
    signalId: string,
    options?: {
      payload?: unknown;
      consumedBy?: { runId: string; stepId: string };
    },
  ): Promise<void> {
    const assignments = ["consumed_at = COALESCE(consumed_at, ?)"];
    const params: Array<string | null> = [new Date().toISOString()];
    if (options !== undefined && "payload" in options) {
      assignments.push("payload_json = ?");
      params.push(JSON.stringify(options.payload) ?? "null");
    }
    if (options?.consumedBy !== undefined) {
      assignments.push("consumed_by_run_id = ?", "consumed_by_step_id = ?");
      params.push(
        options.consumedBy.runId,
        options.consumedBy.stepId,
      );
    }
    assignments.push(
      "signal_match_fingerprint = NULL",
      "operational_signal_ciphertext = NULL",
      "operational_generation = NULL",
    );
    params.push(signalId);
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE signals SET ${assignments.join(", ")} WHERE signal_id = ?`,
        params,
      ),
    );
  }

  async getOperationalSecretValues(
    signalId: string,
  ): Promise<string[]> {
    const row = await this.exec((db) =>
      dbGet<SignalRow>(
        db,
        `SELECT * FROM signals
         WHERE signal_id = ? AND consumed_at IS NULL`,
        [signalId],
      ),
    );
    if (!row) return [];
    return (await this.operationalSignalState(row))
      .resolvedSecretValues;
  }

  async listConsumedByRun(runId: string): Promise<Signal[]> {
    const rows = await this.exec((db) =>
      dbAll<SignalRow>(
        db,
        "SELECT * FROM signals WHERE consumed_at IS NOT NULL AND consumed_by_run_id = ?",
        [runId],
      ),
    );
    return rows.map(rowToSignal);
  }

  async listConsumedWithoutProvenance(): Promise<Signal[]> {
    const rows = await this.exec((db) =>
      dbAll<SignalRow>(
        db,
        "SELECT * FROM signals WHERE consumed_at IS NOT NULL AND consumed_by_run_id IS NULL",
      ),
    );
    return rows.map(rowToSignal);
  }

  async replaceAudit(
    signalId: string,
    audit: Pick<Signal, "name" | "correlationId" | "payload">,
    resolvedSecretValues: readonly string[] = [],
  ): Promise<void> {
    const stored = await this.exec((db) =>
      dbGet<SignalRow>(
        db,
        "SELECT * FROM signals WHERE signal_id = ?",
        [signalId],
      ),
    );
    if (!stored) return;
    const operationalGeneration =
      stored.consumed_at === null
        ? randomUUID()
        : null;
    const priorOperationalState =
      stored.consumed_at === null
        ? await this.operationalSignalState(stored)
        : undefined;
    const operationalSignal =
      stored.consumed_at === null
        ? await sealOperationalState(
            this.operationKeyPath,
            [stored.signal_id, operationalGeneration!, "signal"],
            {
              signal:
                priorOperationalState?.signal ??
                rowToSignal(stored),
              resolvedSecretValues: [
                ...new Set([
                  ...(priorOperationalState?.resolvedSecretValues ??
                    []),
                  ...resolvedSecretValues,
                ]),
              ],
            } satisfies OperationalSignalState,
          )
        : null;
    const signalMatchFingerprint =
      stored.consumed_at === null
        ? (stored.signal_match_fingerprint ??
          this.fingerprint(stored.name, stored.correlation_id))
        : null;
    await this.exec((db) =>
      dbRun(
        db,
        `UPDATE signals
         SET name = ?, correlation_id = ?, payload_json = ?,
             signal_match_fingerprint = ?,
             operational_signal_ciphertext = ?,
             operational_generation = ?
         WHERE signal_id = ?`,
        [
          audit.name,
          audit.correlationId,
          JSON.stringify(audit.payload) ?? "null",
          signalMatchFingerprint,
          operationalSignal,
          operationalGeneration,
          signalId,
        ],
      ),
    );
  }

  async list(): Promise<Signal[]> {
    const rows = await this.exec((db) => dbAll<SignalRow>(db, "SELECT * FROM signals"));
    return rows.map(rowToSignal);
  }

  private async operationalSignal(row: SignalRow): Promise<Signal> {
    return (await this.operationalSignalState(row)).signal;
  }

  private async operationalSignalState(
    row: SignalRow,
  ): Promise<OperationalSignalState> {
    if (
      row.operational_signal_ciphertext === null ||
      row.operational_signal_ciphertext === undefined ||
      row.operational_generation === null ||
      row.operational_generation === undefined
    ) {
      return {
        signal: rowToSignal(row),
        resolvedSecretValues: [],
      };
    }
    const opened = await openOperationalState<
      OperationalSignalState | Signal
    >(
      this.operationKeyPath,
      [row.signal_id, row.operational_generation, "signal"],
      row.operational_signal_ciphertext,
    );
    return "signal" in opened
      ? opened
      : { signal: opened, resolvedSecretValues: [] };
  }
}
