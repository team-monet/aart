// Sqlite concurrent-startup migration race E2E (AMENDMENTS.md A58). DEPLOY.md
// documents `aart server` and `aart worker` as safe to point at the same
// sqlite store concurrently — but until this fix, a genuinely concurrent
// FIRST start against a FRESH store (no prior watermark) could crash either
// or both: `openSqliteStore`'s migration application was a plain "read
// watermark, apply pending, write watermark" sequence with no cross-process
// coordination (MigrationRunner itself, ../migrations/types.ts, is S0-frozen
// and adapter-agnostic — it doesn't and shouldn't know about sqlite-specific
// locking). Two processes both reading watermark 0 could both attempt
// 0002_deployment_promoted's non-idempotent `ALTER TABLE ADD COLUMN`, or
// contend hard enough to exhaust `PRAGMA busy_timeout` and throw "database is
// locked" — see index.ts's own `runMigrationsCoordinated` doc comment for the
// full mechanism and the fix (a `BEGIN IMMEDIATE`-based double-checked-lock
// around the whole migration-application sequence).
//
// Real, separate OS processes — not Promise.all against two in-process
// DatabaseSync connections, and not node:worker_threads either. Both were
// tried during this fix's development and neither faithfully reproduces (or
// correctly exercises the fix for) this race: node:sqlite's DatabaseSync API
// is fully synchronous, so a busy_timeout retry-wait on one in-process
// connection is a genuinely blocking call that stalls the ENTIRE JS thread —
// including whatever pending continuation on the OTHER in-process connection
// is waiting for the event loop to free up to reach its own COMMIT — which
// starves it instead of letting it run concurrently, and the waiting
// connection then reliably times out and throws "database is locked"
// regardless of whether the coordination fix is correct. Only real OS-level
// process parallelism (a genuinely separate thread of execution per
// connection) lets both sides make progress concurrently the way two real
// `aart server`/`aart worker` processes actually do — see
// migration-race-worker.mjs's own header comment for the empirical detail.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(__dirname, "migration-race-worker.mjs");

interface WorkerResult {
  label: string;
  ok: boolean;
  watermark?: number;
  hasPromotedColumn?: boolean;
  /** D2a security hardening (AMENDMENTS.md A59) — proves the THIRD migration (0003_approval_task_authenticated_as) is also correctly coordinated under this exact race, not just the one (0002) this mechanism was originally built for. */
  hasAuthenticatedAsColumn?: boolean;
  /** V1 event log foundation (AMENDMENTS.md A61) — proves the FOURTH migration (0004_events_table) is also correctly coordinated under this exact race — the first of the four that adds a whole TABLE, not just a column. */
  hasEventsTable?: boolean;
  hasIdempotencySchemaVersionColumn?: boolean;
  hasRunRootTaintColumns?: boolean;
  hasArtifactAuditVisibilityColumn?: boolean;
  error?: string;
}

/** Spawns migration-race-worker.mjs as a genuinely separate OS process (`spawn(process.execPath, ...)`, same primitive this repo's other src/e2e/*-worker.mjs harnesses use) and resolves with its single parsed JSON result line once the process exits. */
function runWorker(dbPath: string, label: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, `--path=${dbPath}`, `--label=${label}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", () => {
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!line) {
        reject(new Error(`worker ${label} produced no stdout output. stderr: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(line) as WorkerResult);
      } catch {
        reject(new Error(`worker ${label} produced non-JSON stdout: ${line}. stderr: ${stderr}`));
      }
    });
  });
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("sqlite adapter — concurrent-startup migration race (AMENDMENTS.md A58)", () => {
  // Real process spawn x2 per iteration x N iterations — generous but
  // bounded; see this file's own header comment for why real processes
  // (not Promise.all / worker_threads) are required for a faithful test.
  const ITERATIONS = 8;

  it(
    `two genuinely separate OS processes opening the SAME fresh sqlite store at once, repeated ${ITERATIONS} times: both always come up cleanly, watermark 11, correct schema, no "duplicate column name" / "database is locked" crash`,
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        const dir = await mkdtemp(join(tmpdir(), "aart-sqlite-migration-race-"));
        roots.push(dir);
        const dbPath = join(dir, "aart.db");

        const [a, b] = await Promise.all([runWorker(dbPath, "A"), runWorker(dbPath, "B")]);

        for (const [label, result] of [
          ["A", a],
          ["B", b],
        ] as const) {
          expect(result.ok, `worker ${label} (iteration ${i}) failed: ${result.error}`).toBe(true);
          // V1 event log foundation (AMENDMENTS.md A61) — was 3
          // (0001+0002+0003_approval_task_authenticated_as) as of D2a/A59;
          // now 6 (+0004_events_table,
          // +0005_idempotency_schema_version, and
          // +0006_run_root_taint_paths
          // +0007_secret_audit_provenance
          // +0008_sealed_operational_state
          // +0009_wait_operation_generation
          // +0010_protected_continuation_state
          // +0011_artifact_audit_visibility).
          expect(result.watermark, `worker ${label} (iteration ${i}) watermark`).toBe(11);
          expect(result.hasPromotedColumn, `worker ${label} (iteration ${i}) deployments.promoted column`).toBe(true);
          expect(result.hasAuthenticatedAsColumn, `worker ${label} (iteration ${i}) approval_tasks.authenticated_as column`).toBe(true);
          expect(result.hasEventsTable, `worker ${label} (iteration ${i}) events table`).toBe(true);
          expect(result.hasIdempotencySchemaVersionColumn, `worker ${label} (iteration ${i}) idempotency_ledger.schema_version column`).toBe(true);
          expect(result.hasRunRootTaintColumns, `worker ${label} (iteration ${i}) run root taint columns`).toBe(true);
          expect(result.hasArtifactAuditVisibilityColumn, `worker ${label} (iteration ${i}) artifacts.redaction_audit_visible column`).toBe(true);
        }
      }
    },
    60_000,
  );
});
