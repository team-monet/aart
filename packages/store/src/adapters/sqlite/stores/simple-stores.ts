// Every AartStore member whose SQLite shape is "a table + a handful of
// filters" with no scan/pairing behavior beyond straightforward SQL WHERE
// clauses — mirrors the fs adapter's adapters/fs/simple-stores.ts grouping
// exactly (same member list: Approval, Correction, Eval, Deployment,
// Environment, Schedule, PromptRegistry, SchemaRegistry, PackManifest,
// RejectedTrigger, StandingApproval, JobQueue, IdempotencyLedger).
import type {
  ApprovalTask,
  Correction,
  Deployment,
  Environment,
  EvalExample,
  EvalRun,
  EvalSuite,
  PackManifest,
  PromptRegistryEntry,
  RejectedTrigger,
  Schedule,
  SchemaRegistryEntry,
  StandingApproval,
} from "@aart/types";
import type {
  ApprovalStore,
  CorrectionStore,
  DeploymentStore,
  EnvironmentStore,
  EvalStore,
  IdempotencyLedgerEntry,
  IdempotencyLedgerStore,
  JobQueueEntry,
  JobQueueStore,
  PackManifestStore,
  PromptRegistryStore,
  RejectedTriggerStore,
  ScheduleStore,
  SchemaRegistryStore,
  StandingApprovalStore,
} from "../../../types.js";
import { dbAll, dbGet, dbRun, fromBool, fromBoolOrNull, fromJson, toBool, toBoolOrNull, toJson, type SqlExec } from "../db.js";

// ---------------------------------------------------------------------------
// approval_tasks
// ---------------------------------------------------------------------------

interface ApprovalTaskRow {
  id: string;
  run_id: string;
  step_id: string;
  title: string;
  description: string;
  status: string;
  reviewer: string | null;
  decision_json: string | null;
  created_at: string;
  decided_at: string | null;
}

function rowToApprovalTask(row: ApprovalTaskRow): ApprovalTask {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    title: row.title,
    description: row.description,
    status: row.status as ApprovalTask["status"],
    reviewer: row.reviewer ?? undefined,
    decision: fromJson(row.decision_json),
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  };
}

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly exec: SqlExec) {}

  async get(id: string): Promise<ApprovalTask | undefined> {
    const row = await this.exec((db) => dbGet<ApprovalTaskRow>(db, "SELECT * FROM approval_tasks WHERE id = ?", [id]));
    return row ? rowToApprovalTask(row) : undefined;
  }

  async put(task: ApprovalTask): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO approval_tasks (id, run_id, step_id, title, description, status, reviewer, decision_json, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id, step_id = excluded.step_id, title = excluded.title,
           description = excluded.description, status = excluded.status, reviewer = excluded.reviewer,
           decision_json = excluded.decision_json, created_at = excluded.created_at, decided_at = excluded.decided_at`,
        [task.id, task.runId, task.stepId, task.title, task.description, task.status, task.reviewer ?? null, toJson(task.decision), task.createdAt, task.decidedAt ?? null],
      ),
    );
  }

  async list(filter?: { runId?: string; status?: ApprovalTask["status"] }): Promise<ApprovalTask[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<ApprovalTaskRow>(db, `SELECT * FROM approval_tasks${where}`, params));
    return rows.map(rowToApprovalTask);
  }
}

// ---------------------------------------------------------------------------
// corrections
// ---------------------------------------------------------------------------

interface CorrectionRow {
  run_id: string;
  step_id: string;
  field_path: string;
  observed_json: string;
  corrected_json: string;
  reason: string;
  reviewer: string;
  created_at: string;
}

function rowToCorrection(row: CorrectionRow): Correction {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    fieldPath: row.field_path,
    observed: JSON.parse(row.observed_json) as unknown,
    corrected: JSON.parse(row.corrected_json) as unknown,
    reason: row.reason,
    reviewer: row.reviewer,
    createdAt: row.created_at,
  };
}

export class SqliteCorrectionStore implements CorrectionStore {
  constructor(private readonly exec: SqlExec) {}

  async put(correction: Correction): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO corrections (run_id, step_id, field_path, observed_json, corrected_json, reason, reviewer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_id, field_path) DO UPDATE SET
           observed_json = excluded.observed_json, corrected_json = excluded.corrected_json,
           reason = excluded.reason, reviewer = excluded.reviewer, created_at = excluded.created_at`,
        [correction.runId, correction.stepId, correction.fieldPath, JSON.stringify(correction.observed), JSON.stringify(correction.corrected), correction.reason, correction.reviewer, correction.createdAt],
      ),
    );
  }

  async list(filter?: { runId?: string; stepId?: string }): Promise<Correction[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.runId) {
      clauses.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter?.stepId) {
      clauses.push("step_id = ?");
      params.push(filter.stepId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<CorrectionRow>(db, `SELECT * FROM corrections${where}`, params));
    return rows.map(rowToCorrection);
  }
}

// ---------------------------------------------------------------------------
// eval_suites / eval_examples / eval_runs
// ---------------------------------------------------------------------------

interface EvalSuiteRow {
  suite_id: string;
  name: string;
  description: string | null;
  scorer_json: string;
  tags_json: string;
}
interface EvalExampleRow {
  id: string;
  suite_id: string;
  source_run_id: string | null;
  input_json: string;
  expected_json: string;
  scorer_config_json: string | null;
  tags_json: string | null;
  created_from_correction: string | null;
}
interface EvalRunRow {
  id: string;
  suite_id: string;
  workflow_id: string;
  workflow_version: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  score: number;
  regressions_json: string;
  improvements_json: string;
  report_artifact: string;
}

function rowToEvalSuite(row: EvalSuiteRow): EvalSuite {
  return {
    id: row.suite_id,
    name: row.name,
    description: row.description ?? undefined,
    examples: [],
    scorer: fromJson(row.scorer_json)!,
    tags: fromJson(row.tags_json)!,
  };
}
function rowToEvalExample(row: EvalExampleRow): EvalExample {
  return {
    id: row.id,
    suiteId: row.suite_id,
    sourceRunId: row.source_run_id ?? undefined,
    input: JSON.parse(row.input_json) as unknown,
    expected: JSON.parse(row.expected_json) as unknown,
    scorerConfig: fromJson(row.scorer_config_json),
    tags: fromJson(row.tags_json),
    createdFromCorrection: row.created_from_correction ?? undefined,
  };
}
function rowToEvalRun(row: EvalRunRow): EvalRun {
  return {
    id: row.id,
    suiteId: row.suite_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status as EvalRun["status"],
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    score: row.score,
    regressions: fromJson(row.regressions_json)!,
    improvements: fromJson(row.improvements_json)!,
    reportArtifact: row.report_artifact,
  };
}

export class SqliteEvalStore implements EvalStore {
  constructor(private readonly exec: SqlExec) {}

  async putSuite(suite: EvalSuite): Promise<void> {
    // `EvalSuite.examples` is spec-shaped as embedded on the suite object
    // (§24.1), but this store's `putExample`/`listExamples` methods are the
    // AartStore-documented way examples are actually persisted/queried
    // (architecture §5.3's separate `eval_examples` table, keyed by
    // suite_id). Persisting the suite row's own `examples` array would be a
    // second, divergent source of truth for the same data — this adapter
    // stores the suite's metadata only and reconstructs `examples` via
    // `listExamples` when returning a full suite (see `getSuite`/`listSuites`
    // below), matching how EvalStore's own interface is actually used
    // elsewhere (putExample/listExamples as the real read/write path).
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO eval_suites (suite_id, name, description, scorer_json, tags_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(suite_id) DO UPDATE SET
           name = excluded.name, description = excluded.description,
           scorer_json = excluded.scorer_json, tags_json = excluded.tags_json`,
        [suite.id, suite.name, suite.description ?? null, toJson(suite.scorer)!, toJson(suite.tags)!],
      ),
    );
    for (const example of suite.examples) {
      await this.putExample(example);
    }
  }

  async getSuite(id: string): Promise<EvalSuite | undefined> {
    const row = await this.exec((db) => dbGet<EvalSuiteRow>(db, "SELECT * FROM eval_suites WHERE suite_id = ?", [id]));
    if (!row) return undefined;
    const suite = rowToEvalSuite(row);
    suite.examples = await this.listExamples(id);
    return suite;
  }

  async listSuites(): Promise<EvalSuite[]> {
    const rows = await this.exec((db) => dbAll<EvalSuiteRow>(db, "SELECT * FROM eval_suites"));
    const suites = rows.map(rowToEvalSuite);
    for (const suite of suites) {
      suite.examples = await this.listExamples(suite.id);
    }
    return suites;
  }

  async putExample(example: EvalExample): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO eval_examples (id, suite_id, source_run_id, input_json, expected_json, scorer_config_json, tags_json, created_from_correction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           suite_id = excluded.suite_id, source_run_id = excluded.source_run_id,
           input_json = excluded.input_json, expected_json = excluded.expected_json,
           scorer_config_json = excluded.scorer_config_json, tags_json = excluded.tags_json,
           created_from_correction = excluded.created_from_correction`,
        [example.id, example.suiteId, example.sourceRunId ?? null, JSON.stringify(example.input), JSON.stringify(example.expected), toJson(example.scorerConfig), toJson(example.tags), example.createdFromCorrection ?? null],
      ),
    );
  }

  async listExamples(suiteId: string): Promise<EvalExample[]> {
    const rows = await this.exec((db) => dbAll<EvalExampleRow>(db, "SELECT * FROM eval_examples WHERE suite_id = ?", [suiteId]));
    return rows.map(rowToEvalExample);
  }

  async putRun(run: EvalRun): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO eval_runs (id, suite_id, workflow_id, workflow_version, status, total, passed, failed, score, regressions_json, improvements_json, report_artifact)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           suite_id = excluded.suite_id, workflow_id = excluded.workflow_id, workflow_version = excluded.workflow_version,
           status = excluded.status, total = excluded.total, passed = excluded.passed, failed = excluded.failed,
           score = excluded.score, regressions_json = excluded.regressions_json, improvements_json = excluded.improvements_json,
           report_artifact = excluded.report_artifact`,
        [run.id, run.suiteId, run.workflowId, run.workflowVersion, run.status, run.total, run.passed, run.failed, run.score, toJson(run.regressions)!, toJson(run.improvements)!, run.reportArtifact],
      ),
    );
  }

  async listRuns(filter?: { suiteId?: string; workflowId?: string }): Promise<EvalRun[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.suiteId) {
      clauses.push("suite_id = ?");
      params.push(filter.suiteId);
    }
    if (filter?.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<EvalRunRow>(db, `SELECT * FROM eval_runs${where}`, params));
    return rows.map(rowToEvalRun);
  }
}

// ---------------------------------------------------------------------------
// deployments
// ---------------------------------------------------------------------------

interface DeploymentRow {
  id: string;
  workflow_id: string;
  workflow_version: string;
  environment_id: string;
  trigger_config_json: string;
  bundle_hash: string | null;
  created_at: string;
  // D1 "remotes + push" (AMENDMENTS.md A56) — nullable, no DEFAULT (added by
  // migration 0002_deployment_promoted, not the baseline DDL — see
  // schema.ts). NULL (every row written before this migration ran, and any
  // row this adapter itself never sets it on) must map to `undefined`, never
  // `false` — fromBoolOrNull below, not fromBool, is load-bearing here.
  promoted: number | null;
}
function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    environmentId: row.environment_id,
    triggerConfig: JSON.parse(row.trigger_config_json) as Record<string, unknown>,
    bundleHash: row.bundle_hash ?? undefined,
    createdAt: row.created_at,
    promoted: fromBoolOrNull(row.promoted),
  };
}

export class SqliteDeploymentStore implements DeploymentStore {
  constructor(private readonly exec: SqlExec) {}

  async get(id: string): Promise<Deployment | undefined> {
    const row = await this.exec((db) => dbGet<DeploymentRow>(db, "SELECT * FROM deployments WHERE id = ?", [id]));
    return row ? rowToDeployment(row) : undefined;
  }

  async put(deployment: Deployment): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO deployments (id, workflow_id, workflow_version, environment_id, trigger_config_json, bundle_hash, created_at, promoted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workflow_id = excluded.workflow_id, workflow_version = excluded.workflow_version,
           environment_id = excluded.environment_id, trigger_config_json = excluded.trigger_config_json,
           bundle_hash = excluded.bundle_hash, created_at = excluded.created_at, promoted = excluded.promoted`,
        [deployment.id, deployment.workflowId, deployment.workflowVersion, deployment.environmentId, JSON.stringify(deployment.triggerConfig), deployment.bundleHash ?? null, deployment.createdAt, toBoolOrNull(deployment.promoted)],
      ),
    );
  }

  async list(filter?: { environmentId?: string; workflowId?: string }): Promise<Deployment[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.environmentId) {
      clauses.push("environment_id = ?");
      params.push(filter.environmentId);
    }
    if (filter?.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<DeploymentRow>(db, `SELECT * FROM deployments${where}`, params));
    return rows.map(rowToDeployment);
  }
}

// ---------------------------------------------------------------------------
// environments — dual-keyed by id and name (AMENDMENTS.md A4)
// ---------------------------------------------------------------------------

interface EnvironmentRow {
  id: string;
  name: string;
  config_json: string;
  secret_source_json: string | null;
}
function rowToEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    secretSource: fromJson(row.secret_source_json),
  };
}

export class SqliteEnvironmentStore implements EnvironmentStore {
  constructor(private readonly exec: SqlExec) {}

  async get(id: string): Promise<Environment | undefined> {
    const row = await this.exec((db) => dbGet<EnvironmentRow>(db, "SELECT * FROM environments WHERE id = ?", [id]));
    return row ? rowToEnvironment(row) : undefined;
  }

  async getByName(name: string): Promise<Environment | undefined> {
    const row = await this.exec((db) => dbGet<EnvironmentRow>(db, "SELECT * FROM environments WHERE name = ?", [name]));
    return row ? rowToEnvironment(row) : undefined;
  }

  async put(environment: Environment): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO environments (id, name, config_json, secret_source_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, config_json = excluded.config_json, secret_source_json = excluded.secret_source_json`,
        [environment.id, environment.name, JSON.stringify(environment.config), toJson(environment.secretSource)],
      ),
    );
  }

  async list(): Promise<Environment[]> {
    const rows = await this.exec((db) => dbAll<EnvironmentRow>(db, "SELECT * FROM environments"));
    return rows.map(rowToEnvironment);
  }
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  workflow_id: string;
  workflow_version: string;
  cron: string;
  timezone: string;
  missed_run_policy: string;
  inputs_json: string | null;
  paused: number;
}
function rowToSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    cron: row.cron,
    timezone: row.timezone,
    missedRunPolicy: row.missed_run_policy as Schedule["missedRunPolicy"],
    inputs: fromJson(row.inputs_json),
    paused: fromBool(row.paused),
  };
}

export class SqliteScheduleStore implements ScheduleStore {
  constructor(private readonly exec: SqlExec) {}

  async get(id: string): Promise<Schedule | undefined> {
    const row = await this.exec((db) => dbGet<ScheduleRow>(db, "SELECT * FROM schedules WHERE id = ?", [id]));
    return row ? rowToSchedule(row) : undefined;
  }

  async put(schedule: Schedule): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO schedules (id, workflow_id, workflow_version, cron, timezone, missed_run_policy, inputs_json, paused)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workflow_id = excluded.workflow_id, workflow_version = excluded.workflow_version, cron = excluded.cron,
           timezone = excluded.timezone, missed_run_policy = excluded.missed_run_policy,
           inputs_json = excluded.inputs_json, paused = excluded.paused`,
        [schedule.id, schedule.workflowId, schedule.workflowVersion, schedule.cron, schedule.timezone, schedule.missedRunPolicy, toJson(schedule.inputs), toBool(schedule.paused)],
      ),
    );
  }

  async list(filter?: { workflowId?: string; paused?: boolean }): Promise<Schedule[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.workflowId) {
      clauses.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter?.paused !== undefined) {
      clauses.push("paused = ?");
      params.push(toBool(filter.paused));
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<ScheduleRow>(db, `SELECT * FROM schedules${where}`, params));
    return rows.map(rowToSchedule);
  }
}

// ---------------------------------------------------------------------------
// prompt_registry / schema_registry / pack_manifests — versioned registries
// ---------------------------------------------------------------------------

interface PromptRegistryRow {
  name: string;
  version: string;
  content_hash: string;
  body: string;
}
export class SqlitePromptRegistryStore implements PromptRegistryStore {
  constructor(private readonly exec: SqlExec) {}
  async get(name: string, version: string): Promise<PromptRegistryEntry | undefined> {
    const row = await this.exec((db) => dbGet<PromptRegistryRow>(db, "SELECT * FROM prompt_registry WHERE name = ? AND version = ?", [name, version]));
    return row ? { name: row.name, version: row.version, contentHash: row.content_hash, body: row.body } : undefined;
  }
  async put(entry: PromptRegistryEntry): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO prompt_registry (name, version, content_hash, body) VALUES (?, ?, ?, ?)
         ON CONFLICT(name, version) DO UPDATE SET content_hash = excluded.content_hash, body = excluded.body`,
        [entry.name, entry.version, entry.contentHash, entry.body],
      ),
    );
  }
  async listVersions(name: string): Promise<string[]> {
    const rows = await this.exec((db) => dbAll<{ version: string }>(db, "SELECT version FROM prompt_registry WHERE name = ?", [name]));
    return rows.map((r) => r.version);
  }
}

interface SchemaRegistryRow {
  name: string;
  version: string;
  content_hash: string;
  json_schema: string;
}
export class SqliteSchemaRegistryStore implements SchemaRegistryStore {
  constructor(private readonly exec: SqlExec) {}
  async get(name: string, version: string): Promise<SchemaRegistryEntry | undefined> {
    const row = await this.exec((db) => dbGet<SchemaRegistryRow>(db, "SELECT * FROM schema_registry WHERE name = ? AND version = ?", [name, version]));
    return row ? { name: row.name, version: row.version, contentHash: row.content_hash, jsonSchema: JSON.parse(row.json_schema) as Record<string, unknown> } : undefined;
  }
  async put(entry: SchemaRegistryEntry): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO schema_registry (name, version, content_hash, json_schema) VALUES (?, ?, ?, ?)
         ON CONFLICT(name, version) DO UPDATE SET content_hash = excluded.content_hash, json_schema = excluded.json_schema`,
        [entry.name, entry.version, entry.contentHash, JSON.stringify(entry.jsonSchema)],
      ),
    );
  }
  async listVersions(name: string): Promise<string[]> {
    const rows = await this.exec((db) => dbAll<{ version: string }>(db, "SELECT version FROM schema_registry WHERE name = ?", [name]));
    return rows.map((r) => r.version);
  }
}

interface PackManifestRow {
  name: string;
  version: string;
  content_hash: string;
  manifest_json: string;
  approval_status: string;
}
export class SqlitePackManifestStore implements PackManifestStore {
  constructor(private readonly exec: SqlExec) {}
  async get(name: string, version: string): Promise<PackManifest | undefined> {
    const row = await this.exec((db) => dbGet<PackManifestRow>(db, "SELECT * FROM pack_manifests WHERE name = ? AND version = ?", [name, version]));
    return row ? { name: row.name, version: row.version, contentHash: row.content_hash, manifest: JSON.parse(row.manifest_json) as Record<string, unknown>, approvalStatus: row.approval_status } : undefined;
  }
  async put(manifest: PackManifest): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO pack_manifests (name, version, content_hash, manifest_json, approval_status) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name, version) DO UPDATE SET content_hash = excluded.content_hash, manifest_json = excluded.manifest_json, approval_status = excluded.approval_status`,
        [manifest.name, manifest.version, manifest.contentHash, JSON.stringify(manifest.manifest), manifest.approvalStatus],
      ),
    );
  }
  async listVersions(name: string): Promise<string[]> {
    const rows = await this.exec((db) => dbAll<{ version: string }>(db, "SELECT version FROM pack_manifests WHERE name = ?", [name]));
    return rows.map((r) => r.version);
  }
}

// ---------------------------------------------------------------------------
// rejected_triggers — architecture §6.2
// ---------------------------------------------------------------------------

interface RejectedTriggerRow {
  id: string;
  trigger_type: string;
  reason: string;
  raw_payload_json: string;
  received_at: string;
}
function rowToRejectedTrigger(row: RejectedTriggerRow): RejectedTrigger {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    reason: row.reason as RejectedTrigger["reason"],
    rawPayload: JSON.parse(row.raw_payload_json) as unknown,
    receivedAt: row.received_at,
  };
}

export class SqliteRejectedTriggerStore implements RejectedTriggerStore {
  constructor(private readonly exec: SqlExec) {}

  async append(rejected: RejectedTrigger): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        "INSERT INTO rejected_triggers (id, trigger_type, reason, raw_payload_json, received_at) VALUES (?, ?, ?, ?, ?)",
        [rejected.id, rejected.triggerType, rejected.reason, JSON.stringify(rejected.rawPayload), rejected.receivedAt],
      ),
    );
  }

  async list(filter?: { since?: string; reason?: RejectedTrigger["reason"] }): Promise<RejectedTrigger[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.since) {
      clauses.push("received_at >= ?");
      params.push(filter.since);
    }
    if (filter?.reason) {
      clauses.push("reason = ?");
      params.push(filter.reason);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.exec((db) => dbAll<RejectedTriggerRow>(db, `SELECT * FROM rejected_triggers${where} ORDER BY received_at DESC`, params));
    return rows.map(rowToRejectedTrigger);
  }
}

// ---------------------------------------------------------------------------
// standing_approvals — architecture §7.5, spec §17.6
// ---------------------------------------------------------------------------

interface StandingApprovalRow {
  id: string;
  max_risk_tier: string;
  capabilities_json: string;
  granted_by: string;
  expires_at: string;
}
function rowToStandingApproval(row: StandingApprovalRow): StandingApproval {
  return {
    id: row.id,
    maxRiskTier: row.max_risk_tier,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    grantedBy: row.granted_by,
    expiresAt: row.expires_at,
  };
}

export class SqliteStandingApprovalStore implements StandingApprovalStore {
  constructor(private readonly exec: SqlExec) {}

  async get(id: string): Promise<StandingApproval | undefined> {
    const row = await this.exec((db) => dbGet<StandingApprovalRow>(db, "SELECT * FROM standing_approvals WHERE id = ?", [id]));
    return row ? rowToStandingApproval(row) : undefined;
  }

  async put(approval: StandingApproval): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO standing_approvals (id, max_risk_tier, capabilities_json, granted_by, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET max_risk_tier = excluded.max_risk_tier, capabilities_json = excluded.capabilities_json,
           granted_by = excluded.granted_by, expires_at = excluded.expires_at`,
        [approval.id, approval.maxRiskTier, JSON.stringify(approval.capabilities), approval.grantedBy, approval.expiresAt],
      ),
    );
  }

  async list(): Promise<StandingApproval[]> {
    const rows = await this.exec((db) => dbAll<StandingApprovalRow>(db, "SELECT * FROM standing_approvals"));
    return rows.map(rowToStandingApproval);
  }
}

// ---------------------------------------------------------------------------
// job_queue — architecture §5.3/§4.7. NOT one of AartStore's 16 members.
// `setClaim` is a CONDITIONAL UPDATE (only succeeds if still unclaimed or
// lease-expired) even though the interface signature returns `void` — see
// this task's final report for why: the caller-side race-safe claim helper
// (packages/server's worker claim loop) issues setClaim() then re-reads via
// get() to confirm it actually won, which only works if a losing racer's
// setClaim() is a silent no-op rather than an unconditional overwrite. This
// is what makes concurrent claim attempts against the same SQLite file safe
// across worker PROCESSES (architecture ADR-05's "race-safe... requiring
// real care" consequence) — SQLite serializes the two connections'
// conditional UPDATEs at the file-lock level, so only one can ever match.
// ---------------------------------------------------------------------------

interface JobQueueRow {
  run_id: string;
  claimed_by: string | null;
  claimed_at: string | null;
  priority: number;
  lease_expires_at: string | null;
  reclaim_count: number;
}
function rowToJobQueueEntry(row: JobQueueRow): JobQueueEntry {
  return {
    runId: row.run_id,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    priority: row.priority,
    leaseExpiresAt: row.lease_expires_at,
    reclaimCount: row.reclaim_count,
  };
}

export class SqliteJobQueueStore implements JobQueueStore {
  constructor(private readonly exec: SqlExec) {}

  async enqueue(runId: string, priority = 0): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO job_queue (run_id, claimed_by, claimed_at, priority, lease_expires_at, reclaim_count)
         VALUES (?, NULL, NULL, ?, NULL, 0)
         ON CONFLICT(run_id) DO UPDATE SET priority = excluded.priority`,
        [runId, priority],
      ),
    );
  }

  async get(runId: string): Promise<JobQueueEntry | undefined> {
    const row = await this.exec((db) => dbGet<JobQueueRow>(db, "SELECT * FROM job_queue WHERE run_id = ?", [runId]));
    return row ? rowToJobQueueEntry(row) : undefined;
  }

  async listClaimable(now: string): Promise<JobQueueEntry[]> {
    const rows = await this.exec((db) =>
      dbAll<JobQueueRow>(db, "SELECT * FROM job_queue WHERE claimed_by IS NULL OR lease_expires_at <= ? ORDER BY priority DESC, run_id ASC", [now]),
    );
    return rows.map(rowToJobQueueEntry);
  }

  async setClaim(runId: string, claimedBy: string, leaseExpiresAt: string): Promise<void> {
    await this.exec((db) => {
      const existing = dbGet(db, "SELECT 1 as found FROM job_queue WHERE run_id = ?", [runId]);
      if (!existing) throw new Error(`setClaim: no job_queue entry for run ${runId} — enqueue() first.`);
      // Conditional: only claims if currently unclaimed OR the existing
      // lease has already expired — see module doc comment above.
      return dbRun(
        db,
        `UPDATE job_queue SET claimed_by = ?, claimed_at = ?, lease_expires_at = ?
         WHERE run_id = ? AND (claimed_by IS NULL OR lease_expires_at <= ?)`,
        [claimedBy, new Date().toISOString(), leaseExpiresAt, runId, new Date().toISOString()],
      );
    });
  }

  async renewLease(runId: string, leaseExpiresAt: string): Promise<void> {
    await this.exec((db) => {
      const existing = dbGet(db, "SELECT 1 as found FROM job_queue WHERE run_id = ?", [runId]);
      if (!existing) throw new Error(`renewLease: no job_queue entry for run ${runId}.`);
      return dbRun(db, "UPDATE job_queue SET lease_expires_at = ? WHERE run_id = ?", [leaseExpiresAt, runId]);
    });
  }

  async release(runId: string): Promise<void> {
    await this.exec((db) => dbRun(db, "UPDATE job_queue SET claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL WHERE run_id = ?", [runId]));
  }

  async incrementReclaimCount(runId: string): Promise<number> {
    return this.exec((db) => {
      const existing = dbGet<JobQueueRow>(db, "SELECT * FROM job_queue WHERE run_id = ?", [runId]);
      if (!existing) throw new Error(`incrementReclaimCount: no job_queue entry for run ${runId}.`);
      const next = existing.reclaim_count + 1;
      dbRun(db, "UPDATE job_queue SET reclaim_count = ? WHERE run_id = ?", [next, runId]);
      return next;
    });
  }

  async remove(runId: string): Promise<void> {
    await this.exec((db) => dbRun(db, "DELETE FROM job_queue WHERE run_id = ?", [runId]));
  }
}

// ---------------------------------------------------------------------------
// idempotency_ledger — architecture §4.2/§5.7. Also not one of the 16.
// ---------------------------------------------------------------------------

interface IdempotencyLedgerRow {
  resolved_key: string;
  run_id: string;
  step_id: string;
  recorded_output_json: string;
  created_at: string;
}

export class SqliteIdempotencyLedgerStore implements IdempotencyLedgerStore {
  constructor(private readonly exec: SqlExec) {}

  async get(resolvedKey: string): Promise<IdempotencyLedgerEntry | undefined> {
    const row = await this.exec((db) => dbGet<IdempotencyLedgerRow>(db, "SELECT * FROM idempotency_ledger WHERE resolved_key = ?", [resolvedKey]));
    if (!row) return undefined;
    return {
      resolvedKey: row.resolved_key,
      runId: row.run_id,
      stepId: row.step_id,
      recordedOutput: JSON.parse(row.recorded_output_json) as unknown,
      createdAt: row.created_at,
    };
  }

  async put(entry: IdempotencyLedgerEntry): Promise<void> {
    await this.exec((db) =>
      dbRun(
        db,
        `INSERT INTO idempotency_ledger (resolved_key, run_id, step_id, recorded_output_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resolved_key) DO UPDATE SET run_id = excluded.run_id, step_id = excluded.step_id,
           recorded_output_json = excluded.recorded_output_json, created_at = excluded.created_at`,
        [entry.resolvedKey, entry.runId, entry.stepId, JSON.stringify(entry.recordedOutput), entry.createdAt],
      ),
    );
  }
}
