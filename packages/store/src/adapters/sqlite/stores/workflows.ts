// WorkflowStore — architecture §5.3 `workflows` table.
import type { Workflow } from "@aart/types";
import type { WorkflowStore } from "../../../types.js";
import { dbAll, dbGet, dbRun, toBool, toJson, type SqlExec } from "../db.js";

interface WorkflowRow {
  workflow_id: string;
  version: string;
  definition_json: string;
  approval: string;
  gates_json: string;
  category: string | null;
  keywords_json: string | null;
  needs_review: number;
  promotion_blocked: number;
}

/** Naive semver-ish comparator (numeric segments compare numerically, non-numeric segments compare lexically) — same approach as the fs adapter's workflows.ts, duplicated locally rather than imported: it's a small, self-contained utility and each adapter implementation is independent (no shared-internal coupling between adapters/fs/** and adapters/sqlite/**, which are two different sessions' carve-outs). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = Number(sa);
    const nb = Number(sb);
    if (sa !== "" && sb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  // definition_json is the full, authoritative Workflow object — the
  // extracted columns (approval/gates_json/category/keywords_json/
  // needs_review/promotion_blocked) exist for future SQL-level
  // queryability/indexing (matching architecture §5.3's literal column
  // list) but are never read back here, so they can never drift the
  // returned object away from exactly what was put().
  return JSON.parse(row.definition_json) as Workflow;
}

export class SqliteWorkflowStore implements WorkflowStore {
  constructor(private readonly exec: SqlExec) {}

  async get(workflowId: string, version: string): Promise<Workflow | undefined> {
    const row = await this.exec((db) =>
      dbGet<WorkflowRow>(db, "SELECT * FROM workflows WHERE workflow_id = ? AND version = ?", [workflowId, version]),
    );
    return row ? rowToWorkflow(row) : undefined;
  }

  async getLatest(workflowId: string): Promise<Workflow | undefined> {
    const versions = await this.listVersions(workflowId);
    const latest = versions.at(-1);
    if (!latest) return undefined;
    return this.get(workflowId, latest);
  }

  async put(workflow: Workflow): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO workflows (workflow_id, version, definition_json, approval, gates_json, category, keywords_json, needs_review, promotion_blocked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, version) DO UPDATE SET
           definition_json = excluded.definition_json,
           approval = excluded.approval,
           gates_json = excluded.gates_json,
           category = excluded.category,
           keywords_json = excluded.keywords_json,
           needs_review = excluded.needs_review,
           promotion_blocked = excluded.promotion_blocked`,
        [
          workflow.id,
          workflow.version,
          toJson(workflow)!,
          workflow.approval,
          toJson(workflow.gates)!,
          workflow.category ?? null,
          toJson(workflow.keywords),
          toBool(workflow.needsReview),
          toBool(workflow.promotionBlocked),
        ],
      ),
    );
  }

  async listVersions(workflowId: string): Promise<string[]> {
    const rows = await this.exec((db) => dbAll<{ version: string }>(db, "SELECT version FROM workflows WHERE workflow_id = ?", [workflowId]));
    return rows.map((r) => r.version).sort(compareVersions);
  }

  async listWorkflowIds(): Promise<string[]> {
    const rows = await this.exec((db) => dbAll<{ workflow_id: string }>(db, "SELECT DISTINCT workflow_id FROM workflows"));
    return rows.map((r) => r.workflow_id);
  }
}
