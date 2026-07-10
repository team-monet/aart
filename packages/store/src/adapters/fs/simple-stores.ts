// Thin AartStore-member wrappers around KeyedJsonCollection, for every
// member whose fs shape is "a directory of `<key>.json` files" with no
// special scan/pairing behavior beyond the generic collection primitive
// (contrast waits.ts/runs.ts/signals.ts/artifacts.ts/workflows.ts, which
// each have a genuinely different on-disk shape).
import { createHash } from "node:crypto";
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
} from "../../types.js";
import { KeyedJsonCollection, type StagingBuffer } from "./json-file.js";

function fieldPathHash(fieldPath: string): string {
  return createHash("sha256").update(fieldPath).digest("hex").slice(0, 16);
}

function registryKey(name: string, version: string): string {
  return `${name}__${version}`;
}

export class FsApprovalStore implements ApprovalStore {
  private readonly collection: KeyedJsonCollection<ApprovalTask>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(id: string) {
    return this.collection.get(id);
  }
  put(task: ApprovalTask) {
    return this.collection.put(task.id, task);
  }
  async list(filter?: { runId?: string; status?: ApprovalTask["status"] }): Promise<ApprovalTask[]> {
    const all = await this.collection.list();
    return all
      .filter((t) => (filter?.runId ? t.runId === filter.runId : true))
      .filter((t) => (filter?.status ? t.status === filter.status : true));
  }
}

export class FsCorrectionStore implements CorrectionStore {
  private readonly collection: KeyedJsonCollection<Correction>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  put(correction: Correction) {
    return this.collection.put(`${correction.runId}__${correction.stepId}__${fieldPathHash(correction.fieldPath)}`, correction);
  }
  async list(filter?: { runId?: string; stepId?: string }): Promise<Correction[]> {
    const all = await this.collection.list();
    return all
      .filter((c) => (filter?.runId ? c.runId === filter.runId : true))
      .filter((c) => (filter?.stepId ? c.stepId === filter.stepId : true));
  }
}

export class FsEvalStore implements EvalStore {
  private readonly suites: KeyedJsonCollection<EvalSuite>;
  private readonly examples: KeyedJsonCollection<EvalExample>;
  private readonly runs: KeyedJsonCollection<EvalRun>;
  constructor(suitesDir: string, examplesDir: string, runsDir: string, staging?: StagingBuffer) {
    this.suites = new KeyedJsonCollection(suitesDir, staging);
    this.examples = new KeyedJsonCollection(examplesDir, staging);
    this.runs = new KeyedJsonCollection(runsDir, staging);
  }
  putSuite(suite: EvalSuite) {
    return this.suites.put(suite.id, suite);
  }
  getSuite(id: string) {
    return this.suites.get(id);
  }
  listSuites() {
    return this.suites.list();
  }
  putExample(example: EvalExample) {
    return this.examples.put(example.id, example);
  }
  async listExamples(suiteId: string): Promise<EvalExample[]> {
    return (await this.examples.list()).filter((e) => e.suiteId === suiteId);
  }
  putRun(run: EvalRun) {
    return this.runs.put(run.id, run);
  }
  async listRuns(filter?: { suiteId?: string; workflowId?: string }): Promise<EvalRun[]> {
    const all = await this.runs.list();
    return all
      .filter((r) => (filter?.suiteId ? r.suiteId === filter.suiteId : true))
      .filter((r) => (filter?.workflowId ? r.workflowId === filter.workflowId : true));
  }
}

export class FsDeploymentStore implements DeploymentStore {
  private readonly collection: KeyedJsonCollection<Deployment>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(id: string) {
    return this.collection.get(id);
  }
  put(deployment: Deployment) {
    return this.collection.put(deployment.id, deployment);
  }
  async list(filter?: { environmentId?: string; workflowId?: string }): Promise<Deployment[]> {
    const all = await this.collection.list();
    return all
      .filter((d) => (filter?.environmentId ? d.environmentId === filter.environmentId : true))
      .filter((d) => (filter?.workflowId ? d.workflowId === filter.workflowId : true));
  }
}

export class FsEnvironmentStore implements EnvironmentStore {
  private readonly collection: KeyedJsonCollection<Environment>;
  constructor(dir: string, staging?: StagingBuffer) {
    // Keyed by `name` on disk (architecture §5.2's literal fs layout: `environments/<envName>.json`).
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  async get(id: string): Promise<Environment | undefined> {
    const all = await this.collection.list();
    return all.find((e) => e.id === id);
  }
  getByName(name: string) {
    return this.collection.get(name);
  }
  put(environment: Environment) {
    return this.collection.put(environment.name, environment);
  }
  list() {
    return this.collection.list();
  }
}

export class FsScheduleStore implements ScheduleStore {
  private readonly collection: KeyedJsonCollection<Schedule>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(id: string) {
    return this.collection.get(id);
  }
  put(schedule: Schedule) {
    return this.collection.put(schedule.id, schedule);
  }
  async list(filter?: { workflowId?: string; paused?: boolean }): Promise<Schedule[]> {
    const all = await this.collection.list();
    return all
      .filter((s) => (filter?.workflowId ? s.workflowId === filter.workflowId : true))
      .filter((s) => (filter?.paused !== undefined ? s.paused === filter.paused : true));
  }
}

export class FsPromptRegistryStore implements PromptRegistryStore {
  private readonly collection: KeyedJsonCollection<PromptRegistryEntry>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(name: string, version: string) {
    return this.collection.get(registryKey(name, version));
  }
  put(entry: PromptRegistryEntry) {
    return this.collection.put(registryKey(entry.name, entry.version), entry);
  }
  async listVersions(name: string): Promise<string[]> {
    const keys = await this.collection.listKeys();
    return keys.filter((k) => k.startsWith(`${name}__`)).map((k) => k.slice(name.length + 2));
  }
}

export class FsSchemaRegistryStore implements SchemaRegistryStore {
  private readonly collection: KeyedJsonCollection<SchemaRegistryEntry>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(name: string, version: string) {
    return this.collection.get(registryKey(name, version));
  }
  put(entry: SchemaRegistryEntry) {
    return this.collection.put(registryKey(entry.name, entry.version), entry);
  }
  async listVersions(name: string): Promise<string[]> {
    const keys = await this.collection.listKeys();
    return keys.filter((k) => k.startsWith(`${name}__`)).map((k) => k.slice(name.length + 2));
  }
}

export class FsPackManifestStore implements PackManifestStore {
  private readonly collection: KeyedJsonCollection<PackManifest>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(name: string, version: string) {
    return this.collection.get(registryKey(name, version));
  }
  put(manifest: PackManifest) {
    return this.collection.put(registryKey(manifest.name, manifest.version), manifest);
  }
  async listVersions(name: string): Promise<string[]> {
    const keys = await this.collection.listKeys();
    return keys.filter((k) => k.startsWith(`${name}__`)).map((k) => k.slice(name.length + 2));
  }
}

export class FsRejectedTriggerStore implements RejectedTriggerStore {
  private readonly collection: KeyedJsonCollection<RejectedTrigger>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  append(rejected: RejectedTrigger) {
    return this.collection.put(rejected.id, rejected);
  }
  async list(filter?: { since?: string; reason?: RejectedTrigger["reason"] }): Promise<RejectedTrigger[]> {
    const all = await this.collection.list();
    return all
      .filter((r) => (filter?.since ? r.receivedAt >= filter.since : true))
      .filter((r) => (filter?.reason ? r.reason === filter.reason : true));
  }
}

export class FsStandingApprovalStore implements StandingApprovalStore {
  private readonly collection: KeyedJsonCollection<StandingApproval>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  get(id: string) {
    return this.collection.get(id);
  }
  put(approval: StandingApproval) {
    return this.collection.put(approval.id, approval);
  }
  list() {
    return this.collection.list();
  }
}

export class FsJobQueueStore implements JobQueueStore {
  private readonly collection: KeyedJsonCollection<JobQueueEntry>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  async enqueue(runId: string, priority = 0): Promise<void> {
    await this.collection.put(runId, {
      runId,
      claimedBy: null,
      claimedAt: null,
      priority,
      leaseExpiresAt: null,
      reclaimCount: 0,
    });
  }
  get(runId: string) {
    return this.collection.get(runId);
  }
  async listClaimable(now: string): Promise<JobQueueEntry[]> {
    const all = await this.collection.list();
    return all.filter((e) => e.claimedBy === null || (e.leaseExpiresAt !== null && e.leaseExpiresAt <= now));
  }
  async setClaim(runId: string, claimedBy: string, leaseExpiresAt: string): Promise<void> {
    const existing = await this.collection.get(runId);
    if (!existing) throw new Error(`setClaim: no job_queue entry for run ${runId} — enqueue() first.`);
    await this.collection.put(runId, { ...existing, claimedBy, claimedAt: new Date().toISOString(), leaseExpiresAt });
  }
  async renewLease(runId: string, leaseExpiresAt: string): Promise<void> {
    const existing = await this.collection.get(runId);
    if (!existing) throw new Error(`renewLease: no job_queue entry for run ${runId}.`);
    await this.collection.put(runId, { ...existing, leaseExpiresAt });
  }
  async release(runId: string): Promise<void> {
    const existing = await this.collection.get(runId);
    if (!existing) return;
    await this.collection.put(runId, { ...existing, claimedBy: null, claimedAt: null, leaseExpiresAt: null });
  }
  async incrementReclaimCount(runId: string): Promise<number> {
    const existing = await this.collection.get(runId);
    if (!existing) throw new Error(`incrementReclaimCount: no job_queue entry for run ${runId}.`);
    const reclaimCount = existing.reclaimCount + 1;
    await this.collection.put(runId, { ...existing, reclaimCount });
    return reclaimCount;
  }
  remove(runId: string) {
    return this.collection.delete(runId);
  }
}

export class FsIdempotencyLedgerStore implements IdempotencyLedgerStore {
  private readonly collection: KeyedJsonCollection<IdempotencyLedgerEntry>;
  constructor(dir: string, staging?: StagingBuffer) {
    this.collection = new KeyedJsonCollection(dir, staging);
  }
  private fileKey(resolvedKey: string): string {
    return createHash("sha256").update(resolvedKey).digest("hex");
  }
  get(resolvedKey: string) {
    return this.collection.get(this.fileKey(resolvedKey));
  }
  put(entry: IdempotencyLedgerEntry) {
    return this.collection.put(this.fileKey(entry.resolvedKey), entry);
  }
}
