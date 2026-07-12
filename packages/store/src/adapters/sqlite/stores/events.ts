// EventLogStore — V1 event log foundation (AMENDMENTS.md A61), the `events`
// table created by migration `0004_events_table` (../migrations.ts). Unlike
// the fs adapter's FsEventLogStore (deliberately NOT staged by transact() —
// see that class's own module comment and AartStore.transact's doc comment
// in ../../../types.ts), this adapter's `events` writes DO participate in
// the real SQLite transaction opened by transact() — mirrors
// stores/signals.ts's own identical reasoning: SQLite gives a genuine
// BEGIN/COMMIT here, so there is no fs-specific "no native cross-file
// transaction" gap to preserve.
import type { EventLogEntry } from "@aart/types";
import type { EventLogStore } from "../../../types.js";
import { dbAll, dbRun, type SqlExec, type SqlParam } from "../db.js";

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  summary: string;
  workflow_id: string | null;
  workflow_version: string | null;
  run_id: string | null;
  deployment_id: string | null;
  environment_id: string | null;
  approval_task_id: string | null;
  actor: string | null;
}

function rowToEvent(row: EventRow): EventLogEntry {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    summary: row.summary,
    workflowId: row.workflow_id ?? undefined,
    workflowVersion: row.workflow_version ?? undefined,
    runId: row.run_id ?? undefined,
    deploymentId: row.deployment_id ?? undefined,
    environmentId: row.environment_id ?? undefined,
    approvalTaskId: row.approval_task_id ?? undefined,
    actor: row.actor ?? undefined,
  };
}

export class SqliteEventLogStore implements EventLogStore {
  constructor(private readonly exec: SqlExec) {}

  async append(entry: EventLogEntry): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO events (id, type, occurred_at, summary, workflow_id, workflow_version, run_id, deployment_id, environment_id, approval_task_id, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.type,
          entry.occurredAt,
          entry.summary,
          entry.workflowId ?? null,
          entry.workflowVersion ?? null,
          entry.runId ?? null,
          entry.deploymentId ?? null,
          entry.environmentId ?? null,
          entry.approvalTaskId ?? null,
          entry.actor ?? null,
        ],
      ),
    );
  }

  async list(filter?: { since?: string; limit?: number }): Promise<EventLogEntry[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter?.since) {
      clauses.push("occurred_at >= ?");
      params.push(filter.since);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    let limitClause = "";
    if (filter?.limit !== undefined) {
      limitClause = " LIMIT ?";
      params.push(filter.limit);
    }
    const rows = await this.exec((db) => dbAll<EventRow>(db, `SELECT * FROM events${where} ORDER BY occurred_at DESC${limitClause}`, params));
    return rows.map(rowToEvent);
  }
}
