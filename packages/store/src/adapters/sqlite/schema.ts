// SQLite DDL — architecture §5.3 "SQLite/Postgres tables (production
// adapters)", table-per-AartStore-member. This is S2's declared carve-out
// into S0's package (implementation plan §3 preamble / Appendix ownership
// table): packages/store/src/adapters/sqlite/** only — the AartStore
// interface, fs adapter, migration framework, and conformance suite above
// this directory remain S0-frozen and untouched.
//
// Two deliberate, documented divergences from architecture §5.3's LITERAL
// column list (neither is an AartStore interface-shape change — both are
// purely about how this adapter physically stores data in its own
// carve-out, which is this session's discretion per the carve-out grant).
// See this task's final report / AMENDMENTS.md for the full rationale:
//
// 1. `runs.trace_json` / `runs.waits_json` / `runs.artifacts_json` hold the
//    full RunRecord.trace/waits/artifacts arrays directly, rather than
//    architecture's literal separate `step_traces` table (+ reconstruction
//    via a run_id-scoped join). Reconstructing RunRecord.waits[] from
//    architecture's own `waits` table specifically would be actively WRONG
//    (that table — this adapter's WaitStore — holds only the CURRENT
//    outstanding wait per (run_id, step_id), deleted on resolve per
//    architecture §5.6/the WaitStore.delete contract; RunRecord.waits is an
//    ever-growing historical array per architecture §4.4 step 4, "RunRecord
//    .waits array gets this WaitCondition appended" — the two are related
//    but not interchangeable, and no join against the frozen WaitStore
//    table's rows can recover a resolved-and-deleted wait). Since
//    RunStore.get()/put() is the ONLY interface surface for trace/waits/
//    artifacts (no AartStore member exposes step-trace-level SQL access
//    independent of the parent RunRecord) and S0's conformance suite
//    requires exact round-trip fidelity (`toEqual` deep equality), storing
//    these three arrays as columns on `runs` directly is the simplest
//    correct design — it trivially guarantees fidelity instead of risking a
//    lossy or drifting reconstruction. `step_traces` as a literal, real-SQL-
//    queryable table (e.g. for a future "list all failed steps across
//    runs" dashboard/evidence query) is left as documented future work
//    rather than built speculatively with no current caller and real
//    dual-write drift risk.
// 2. `runs.schema_version` — architecture §5.3's literal `runs` column list
//    predates the later-amended `RunRecord.schemaVersion` field (architecture
//    §4.7/A8, a required field on the S0-frozen `RunRecordSchema` — see
//    packages/types/src/run.ts). This adapter adds the column so the
//    frozen type's required field actually has a home; this is a gap-fill
//    (the SQL listing was never updated after the type gained the field),
//    not a contradiction to resolve.
//
// `artifacts.path_or_uri` follows architecture §5.4 literally: SQLite holds
// only Artifact METADATA; bytes are written to a local blob file (fs — the
// dev/single-node-production tier this adapter targets) at the path this
// column records, never inlined into a SQL column. An S3-compatible blob
// backend (architecture §5.1/§5.4, and plan §8's founder-optional S3 creds)
// is a documented future extension of the same path_or_uri pointer
// convention, not built here (no S3 credentials are a build-time
// requirement for this adapter — plan §8 explicitly names this optional).
export const SQLITE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflows (
    workflow_id TEXT NOT NULL,
    version TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    approval TEXT NOT NULL,
    gates_json TEXT NOT NULL,
    category TEXT,
    keywords_json TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    promotion_blocked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workflow_id, version)
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    status TEXT NOT NULL,
    approved INTEGER NOT NULL,
    approval_mode TEXT NOT NULL,
    trigger_json TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    params_json TEXT,
    trace_json TEXT NOT NULL,
    waits_json TEXT NOT NULL,
    outputs_json TEXT,
    error TEXT,
    artifacts_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    flag_json TEXT,
    schema_version INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_workflow_id ON runs(workflow_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status)`,

  // The exactly-once resume dedupe ledger (architecture §4.4.2) — the
  // SQLite analogue of the fs adapter's per-run `_dedupeConsumed` sidecar
  // array (adapters/fs/runs.ts). Unlike the fs adapter, this doesn't need
  // to be co-located inside the same file as `runs` for atomicity — SQLite
  // gives this adapter a REAL transaction, so a normal FK-less join table
  // participating in the same BEGIN/COMMIT as the `runs` write already
  // satisfies "dedupe-consumed + run-state-transition commit together."
  `CREATE TABLE IF NOT EXISTS run_dedupe_keys (
    run_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    PRIMARY KEY (run_id, dedupe_key)
  )`,

  `CREATE TABLE IF NOT EXISTS waits (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    wait_condition_json TEXT NOT NULL,
    wait_type TEXT NOT NULL,
    resume_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_waits_due ON waits(wait_type, resume_at)`,

  `CREATE TABLE IF NOT EXISTS signals (
    signal_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL,
    consumed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signals_match ON signals(name, correlation_id)`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    path_or_uri TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)`,

  `CREATE TABLE IF NOT EXISTS approval_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewer TEXT,
    decision_json TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approval_tasks_run ON approval_tasks(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status)`,

  `CREATE TABLE IF NOT EXISTS standing_approvals (
    id TEXT PRIMARY KEY,
    max_risk_tier TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS corrections (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    field_path TEXT NOT NULL,
    observed_json TEXT NOT NULL,
    corrected_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id, field_path)
  )`,

  `CREATE TABLE IF NOT EXISTS eval_suites (
    suite_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scorer_json TEXT NOT NULL,
    tags_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS eval_examples (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    source_run_id TEXT,
    input_json TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    scorer_config_json TEXT,
    tags_json TEXT,
    created_from_correction TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_examples_suite ON eval_examples(suite_id)`,

  `CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    suite_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    score REAL NOT NULL,
    regressions_json TEXT NOT NULL,
    improvements_json TEXT NOT NULL,
    report_artifact TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite_id)`,
  `CREATE INDEX IF NOT EXISTS idx_eval_runs_workflow ON eval_runs(workflow_id)`,

  // `promoted` (D1 "remotes + push", AMENDMENTS.md A56) is deliberately NOT
  // listed here — it's added by migration 0002_deployment_promoted
  // (migrations.ts) via ALTER TABLE, not this baseline DDL, so that a
  // pre-existing database upgrading through 0002 and a brand-new database
  // running 0001 then 0002 in sequence both converge on the identical final
  // `deployments` shape (see that migration's own doc comment for why this
  // ordering matters: it's what makes an old row's column read back SQL
  // NULL / TS `undefined`, not `false`).
  `CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    trigger_config_json TEXT NOT NULL,
    bundle_hash TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_workflow ON deployments(workflow_id)`,

  `CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    config_json TEXT NOT NULL,
    secret_source_json TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    missed_run_policy TEXT NOT NULL,
    inputs_json TEXT,
    paused INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_workflow ON schedules(workflow_id)`,

  `CREATE TABLE IF NOT EXISTS prompt_registry (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (name, version)
  )`,

  `CREATE TABLE IF NOT EXISTS schema_registry (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    json_schema TEXT NOT NULL,
    PRIMARY KEY (name, version)
  )`,

  `CREATE TABLE IF NOT EXISTS pack_manifests (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    approval_status TEXT NOT NULL,
    PRIMARY KEY (name, version)
  )`,

  // job_queue — architecture §5.3/§4.7. NOT one of AartStore's 16 members
  // (engine/worker-internal plumbing, same as the fs adapter's treatment).
  `CREATE TABLE IF NOT EXISTS job_queue (
    run_id TEXT PRIMARY KEY,
    claimed_by TEXT,
    claimed_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    reclaim_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_queue_claimable ON job_queue(claimed_by, lease_expires_at)`,

  // idempotency_ledger — architecture §4.2/§5.7. Also not one of the 16.
  `CREATE TABLE IF NOT EXISTS idempotency_ledger (
    resolved_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    recorded_output_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS rejected_triggers (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rejected_triggers_received ON rejected_triggers(received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rejected_triggers_reason ON rejected_triggers(reason)`,
];

// Deliberately named `_migration_watermark`, NOT `schema_version` — the
// per-RECORD `RunRecord.schemaVersion`/`WaitCondition.schemaVersion` tag
// (architecture §4.7) and the whole-STORE migration watermark
// (architecture §5.5) are explicitly documented as two things that must
// not be confused "in code or logs" (packages/types/src/run.ts's own
// comment, architecture A8). Using the same name for both concepts is
// exactly the confusion that comment warns against, so this table gets a
// visibly-distinct, adapter-internal-looking name instead.
//
// Deliberately NOT part of `SQLITE_SCHEMA_STATEMENTS` above (which is only
// applied once migration 0001_init actually runs, architecture §5.5's
// migration framework's own job) — this table is bootstrapping
// infrastructure the watermark-reading mechanism itself depends on, so it
// must exist before `MigrationRunner.currentVersion()`'s very first read,
// independent of whether any migration has run yet. This mirrors the fs
// adapter's watermark store, which has no migration dependency either
// (FsMigrationWatermarkStore.read() just treats a missing
// schema-version.json as watermark 0, no bootstrapping step required for
// a plain file). db.ts's `openSqliteDb` runs this immediately on connection
// open, before any migration machinery is invoked.
export const MIGRATION_WATERMARK_TABLE_STATEMENT = `CREATE TABLE IF NOT EXISTS _migration_watermark (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
)`;
