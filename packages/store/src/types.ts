// AartStore — architecture §5 (§28.3-anchored). 17 members (spec §28.3's 8
// run-data members + 8 architecture-introduced control-plane members + a
// 17th, `events`, added via the amendment protocol below — AMENDMENTS.md
// A61, V1 event log foundation) plus the cross-cutting `transact()`
// unit-of-work method (architecture §5.8).
//
// Neither spec nor architecture gives explicit method signatures for the
// per-member sub-interfaces below (spec §28.3 gives one-line prose
// contracts; architecture §5.3 gives SQL columns) — designing these method
// shapes is this module's own job as the S0-frozen starting interface every
// adapter (this package's fs adapter, and Wave-1's SQLite/Postgres
// adapters) implements and every consuming package (S1 engine, S2 server,
// S4 governance, S6 evidence, S7 registry) builds against. Kept
// deliberately small and consistent (get/put/list plus the few query shapes
// actually implied by how each store is used elsewhere in both docs) rather
// than exhaustive — a Wave-1 session that needs one more query method adds
// it through the amendment protocol (plan §7), which is the intended path,
// not a sign this interface was designed wrong.
import type {
  Artifact,
  ApprovalTask,
  Correction,
  Deployment,
  Environment,
  EvalExample,
  EvalRun,
  EvalSuite,
  EventLogEntry,
  PackManifest,
  PromptRegistryEntry,
  RejectedTrigger,
  RunRecord,
  RunStatus,
  Schedule,
  SchemaRegistryEntry,
  Signal,
  StandingApproval,
  WaitCondition,
  Workflow,
} from "@aart/types";

// ---------------------------------------------------------------------------
// 8 run-data members — spec §28.3
// ---------------------------------------------------------------------------

export interface WorkflowStore {
  get(workflowId: string, version: string): Promise<Workflow | undefined>;
  /** The latest (highest-`approval`-precedence-agnostic — just most-recently-put) version for a workflowId, if any. Convenience over listVersions + get; adapters may implement it however is natural for their storage model. */
  getLatest(workflowId: string): Promise<Workflow | undefined>;
  put(workflow: Workflow): Promise<void>;
  listVersions(workflowId: string): Promise<string[]>;
  /** Every known workflowId (each with at least one version stored). */
  listWorkflowIds(): Promise<string[]>;
}

export interface RunStore {
  get(runId: string): Promise<RunRecord | undefined>;
  put(run: RunRecord): Promise<void>;
  list(filter?: { status?: RunStatus; workflowId?: string }): Promise<RunRecord[]>;
  /**
   * Engine-only exact state for a pending or currently-running
   * continuation whose public RunRecord may contain redaction markers.
   * This state is sealed at rest from intake onward and updated atomically
   * with every public progress write.
   */
  getOperationalState(
    runId: string,
  ): Promise<RunOperationalState | undefined>;
  /** Creates or replaces the protected active continuation. */
  putOperationalState(
    runId: string,
    state: RunOperationalState,
  ): Promise<void>;
  /** Replaces it only when one already exists. */
  replaceOperationalState(
    runId: string,
    state: RunOperationalState,
  ): Promise<void>;
  /** Removes it at the next terminal or durably-suspended boundary. */
  deleteOperationalState(runId: string): Promise<void>;
  /**
   * The exactly-once resume dedupe ledger (architecture §4.4.2): has this
   * exact key — `(runId, waitStepId, signal.name + signal.correlationId)`
   * for signal-matched resume, or an equivalent caller-constructed key for
   * scheduler-tick/direct-lookup resume (architecture §4.4.2's "scope of
   * the atomic-claim rule" note: all three mechanisms, not just
   * signal-matched) — already been recorded consumed for this run?
   */
  hasDedupeKey(runId: string, dedupeKey: string): Promise<boolean>;
  /**
   * Records a dedupe key as consumed. Callers are expected to call this
   * together with `put()` inside the same `AartStore.transact()` call
   * (architecture §5.8) — the fs adapter co-locates a run's dedupe-consumed
   * set inside the same on-disk file as its RunRecord (see
   * adapters/fs/runs.ts), so staging both writes through the same
   * transaction buffer coalesces them into one atomic write-temp-then-
   * rename, exactly satisfying architecture §4.4.2's "dedupe must be
   * store-transactional or the exactly-once guarantee is fiction."
   */
  recordDedupeKey(runId: string, dedupeKey: string): Promise<void>;
}

export interface WaitStore {
  get(runId: string, stepId: string): Promise<WaitCondition | undefined>;
  put(
    runId: string,
    stepId: string,
    wait: WaitCondition,
    createdAt: string,
    operationalRunState?: WaitOperationalRunState,
  ): Promise<void>;
  /**
   * Engine-only run state captured at suspension. Public RunRecord fields
   * may be redacted after a later secret discovery, so exact continuation
   * reads this sealed copy and rehydrates the segment's known literals.
   */
  getOperationalRunState(
    runId: string,
    stepId: string,
  ): Promise<WaitOperationalRunState | undefined>;
  /**
   * Replaces the protected continuation state for every outstanding wait
   * on a run. The engine uses this before rewriting its public RunRecord.
   */
  replaceOperationalRunState(
    runId: string,
    state: WaitOperationalRunState,
  ): Promise<void>;
  /**
   * Replaces only the user-visible audit copy while preserving the
   * adapter-internal one-way match fingerprint written by `put()`.
   */
  redactAudit(runId: string, stepId: string, wait: WaitCondition): Promise<void>;
  delete(runId: string, stepId: string): Promise<void>;
  /** User-visible, persistence-safe audit rows. */
  list(filter?: { runId?: string }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>>;
  /**
   * Engine-only operational rows. Values are sealed at rest separately
   * from the public audit copy and materialized only for scheduling,
   * expiry, polling, or an atomic claim.
   */
  listOperational(filter?: {
    runId?: string;
    type?: WaitCondition["type"];
  }): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition; createdAt: string }>>;
  /**
   * Matches a resolving signal through an adapter-internal one-way
   * fingerprint, so a redacted correlation value need not remain in the
   * durable audit row.
   */
  findSignalMatches(
    name: string,
    correlationId: string,
  ): Promise<Array<{ runId: string; stepId: string }>>;
  /**
   * The engine-owned query architecture §4.4.3/§4.7 names explicitly:
   * `getDueWaits(now)` — every `timer`-type wait (and poll-mode
   * `external_job` wait) whose deadline has passed, for S2's scheduler
   * ticker to call. S1 exports the wrapping function; this is the store
   * primitive it's built on.
   */
  listDue(now: string): Promise<Array<{ runId: string; stepId: string; wait: WaitCondition }>>;
}

export interface SignalStore {
  /**
   * Appends the durable, append-only audit record (architecture §5.2:
   * `signals/<correlationId>__<receivedAt>.json`). Deliberately NOT staged
   * by `transact()` (see AartStore.transact's own doc comment) — this
   * write always lands immediately, matching the fs adapter's documented
   * non-atomic gap (architecture §5.8).
   */
  append(signal: Signal): Promise<void>;
  /** The check-at-creation lookup architecture §4.4/§5.6 requires: an unconsumed Signal matching (name, correlationId), if one already arrived before its wait was created. */
  findUnconsumedMatch(name: string, correlationId: string): Promise<Signal | undefined>;
  /** Secret literals that caused an unconsumed signal's audit redaction. */
  getOperationalSecretValues(signalId: string): Promise<string[]>;
  /**
   * Marks the audit copy consumed. When a resolving control expression has
   * just enlarged the known-secret set, callers also replace the payload
   * with its redacted form in the same adapter operation.
   * See `append`'s doc comment on the fs adapter's non-atomicity.
   */
  markConsumed(
    signalId: string,
    options?: {
      payload?: unknown;
      consumedBy?: { runId: string; stepId: string };
    },
  ): Promise<void>;
  /** Consumed audit copies associated with a run, for late-secret repair. */
  listConsumedByRun(runId: string): Promise<Signal[]>;
  /** Pre-provenance consumed rows from stores created before migration 0007. */
  listConsumedWithoutProvenance(): Promise<Signal[]>;
  /**
   * Security-only audit rewrite. Unconsumed signals retain a separately
   * sealed operational copy so exact early-arrival matching still works;
   * consumption state, provenance, identity, and receipt time are immutable.
   */
  replaceAudit(
    signalId: string,
    audit: Pick<Signal, "name" | "correlationId" | "payload">,
    resolvedSecretValues?: readonly string[],
  ): Promise<void>;
  list(): Promise<Signal[]>;
}

export interface WaitOperationalRunState {
  run: RunRecord;
  resolvedSecretValues: string[];
  /**
   * Cache replays claimed from the ledger but not yet represented by a
   * durable StepTrace. Kept in sealed state so revocation can reach a
   * consumer even when it races the replay's normal progress write.
   */
  pendingIdempotencyReplays?: IdempotencyReplayClaim[];
}

export type RunOperationalState = WaitOperationalRunState;

export interface ArtifactStore {
  put(
    artifact: Artifact,
    bytes: Uint8Array,
    options?: {
      /**
       * Classification captured from the original MIME before its public
       * audit value is redacted. Once stored, adapters keep the first value.
       */
      redactionTextEligible?: boolean;
    },
  ): Promise<void>;
  getMetadata(artifactId: string): Promise<Artifact | undefined>;
  getBytes(artifactId: string): Promise<Uint8Array | undefined>;
  /** All customer-visible artifact audit rows. */
  list(): Promise<Artifact[]>;
  listByRun(runId: string): Promise<Artifact[]>;
  /** Stable classification retained before audit MIME values are redacted. */
  isTextEligible(artifactId: string): Promise<boolean>;
  /**
   * Rewrites only customer-visible metadata and, optionally, content bytes.
   * Artifact identity/ownership/timestamps and the text classification stay
   * fixed.
   */
  replaceAudit(
    artifactId: string,
    audit: Pick<Artifact, "name" | "kind" | "mime" | "path">,
    bytes?: Uint8Array,
  ): Promise<Artifact | undefined>;
}

export interface ApprovalStore {
  get(id: string): Promise<ApprovalTask | undefined>;
  put(task: ApprovalTask): Promise<void>;
  list(filter?: { runId?: string; status?: ApprovalTask["status"] }): Promise<ApprovalTask[]>;
}

export interface CorrectionStore {
  put(correction: Correction): Promise<void>;
  /**
   * Replaces a correction audit even when redaction changes its fieldPath
   * key. The old keyed row/file is removed in the same adapter operation.
   */
  replaceAudit(
    original: Pick<Correction, "runId" | "stepId" | "fieldPath">,
    audit: Pick<
      Correction,
      "fieldPath" | "observed" | "corrected" | "reason" | "reviewer"
    >,
  ): Promise<void>;
  list(filter?: { runId?: string; stepId?: string }): Promise<Correction[]>;
}

export interface EvalStore {
  putSuite(suite: EvalSuite): Promise<void>;
  getSuite(id: string): Promise<EvalSuite | undefined>;
  listSuites(): Promise<EvalSuite[]>;
  putExample(example: EvalExample): Promise<void>;
  listExamples(suiteId: string): Promise<EvalExample[]>;
  putRun(run: EvalRun): Promise<void>;
  listRuns(filter?: { suiteId?: string; workflowId?: string }): Promise<EvalRun[]>;
}

// ---------------------------------------------------------------------------
// 8 architecture-introduced control-plane members — architecture §5,
// FLAGGED DIVERGENCE from spec §28.3 (which has 8 members total, not 16).
// ---------------------------------------------------------------------------

export interface DeploymentStore {
  get(id: string): Promise<Deployment | undefined>;
  put(deployment: Deployment): Promise<void>;
  list(filter?: { environmentId?: string; workflowId?: string }): Promise<Deployment[]>;
}

export interface EnvironmentStore {
  /** Architecture §5.3's SQL table primary-keys on `id`; architecture §5's one-line contract states "keyed by name" — both are real, so both lookups are exposed rather than picking one over the other. */
  get(id: string): Promise<Environment | undefined>;
  getByName(name: string): Promise<Environment | undefined>;
  put(environment: Environment): Promise<void>;
  list(): Promise<Environment[]>;
}

export interface ScheduleStore {
  get(id: string): Promise<Schedule | undefined>;
  put(schedule: Schedule): Promise<void>;
  list(filter?: { workflowId?: string; paused?: boolean }): Promise<Schedule[]>;
}

export interface PromptRegistryStore {
  get(name: string, version: string): Promise<PromptRegistryEntry | undefined>;
  put(entry: PromptRegistryEntry): Promise<void>;
  listVersions(name: string): Promise<string[]>;
}

export interface SchemaRegistryStore {
  get(name: string, version: string): Promise<SchemaRegistryEntry | undefined>;
  put(entry: SchemaRegistryEntry): Promise<void>;
  listVersions(name: string): Promise<string[]>;
}

export interface PackManifestStore {
  get(name: string, version: string): Promise<PackManifest | undefined>;
  put(manifest: PackManifest): Promise<void>;
  listVersions(name: string): Promise<string[]>;
  /** Every installed/authored pack name with at least one recorded version. */
  listNames(): Promise<string[]>;
}

export interface RejectedTriggerStore {
  append(rejected: RejectedTrigger): Promise<void>;
  list(filter?: { since?: string; reason?: RejectedTrigger["reason"] }): Promise<RejectedTrigger[]>;
}

export interface StandingApprovalStore {
  get(id: string): Promise<StandingApproval | undefined>;
  put(approval: StandingApproval): Promise<void>;
  list(): Promise<StandingApproval[]>;
}

// ---------------------------------------------------------------------------
// events — the 17th AartStore member, added via the amendment protocol
// (AMENDMENTS.md A61, V1 "event log foundation") rather than architecture
// §5's original 16-member enumeration above — the activity-feed +
// live-updates spine every real write site across CLI/MCP/dashboard appends
// to. Facts are append-only: `replaceAudit` may rewrite only data-bearing
// presentation fields after a value is learned to be secret; it cannot
// change event identity, type, ordering, or correlation fields.
// Deliberately NOT staged by the fs adapter's `transact()` — see that
// method's own doc comment below and adapters/fs/events.ts's module
// comment; every real write site goes through packages/store/src/
// event-log.ts's `recordEvent`, never `store.events.append` directly, so
// the "a failed event-log write must never fail the primary operation it's
// observing" contract is enforced in one place.
// ---------------------------------------------------------------------------

export interface EventLogStore {
  append(entry: EventLogEntry): Promise<void>;
  /**
   * Security-only rewrite of an existing audit row after a value is learned
   * to be secret. Structural identity and ordering fields stay unchanged.
   */
  replaceAudit(
    eventId: string,
    audit: { summary: string; actor?: string },
  ): Promise<void>;
  /** Newest-first (descending `occurredAt`). `since` and `limit` are independent, freely-combinable optional filters. */
  list(filter?: {
    since?: string;
    limit?: number;
    runId?: string;
  }): Promise<EventLogEntry[]>;
}

// ---------------------------------------------------------------------------
// job_queue — architecture §5.3/§4.7. Explicitly NOT one of AartStore's 17
// members ("engine/worker-internal plumbing... an implementation detail
// behind @aart/store's claim/release methods", architecture §5.3). Its
// SHAPE (including lease_expires_at/reclaim_count) is S0 scope per this
// session's DoD; the actual claim-race-safety/reclaim-sweep/graceful-
// shutdown BUSINESS LOGIC on top of these primitives is Wave-1 scope (S1's
// dispatch/claim path, S2's worker liveness — architecture §4.7).
// ---------------------------------------------------------------------------

export interface JobQueueEntry {
  runId: string;
  claimedBy: string | null;
  claimedAt: string | null;
  priority: number;
  leaseExpiresAt: string | null;
  reclaimCount: number;
}

export interface JobQueueStore {
  enqueue(runId: string, priority?: number): Promise<void>;
  get(runId: string): Promise<JobQueueEntry | undefined>;
  /** Every currently-claimable entry: never claimed, or claimed with an expired lease. Does NOT itself claim anything (no atomic compare-and-set) — that race-safe claim step is Wave-1's to build (fs is single-process, so ADR-05's "trivial for fs" note applies; a real claim primitive matters starting with the SQLite/Postgres adapters). */
  listClaimable(now: string): Promise<JobQueueEntry[]>;
  setClaim(runId: string, claimedBy: string, leaseExpiresAt: string): Promise<void>;
  renewLease(runId: string, leaseExpiresAt: string): Promise<void>;
  release(runId: string): Promise<void>;
  incrementReclaimCount(runId: string): Promise<number>;
  remove(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// idempotency_ledger — architecture §4.2/§5.7. A dedicated table/collection,
// deliberately not folded into step_traces (a resolved key must be
// checkable before that attempt's StepTrace row exists). Also not one of
// AartStore's 17 spec/architecture/amendment-enumerated members, for the
// same "engine-owned mechanism, store-internal plumbing" reason as job_queue.
// ---------------------------------------------------------------------------

export interface IdempotencyLedgerEntry {
  resolvedKey: string;
  runId: string;
  stepId: string;
  /** Stable producer occurrence; absent on legacy ledger rows. */
  traceSeq?: number;
  recordedOutput: unknown;
  createdAt: string;
  /** Absent on legacy entries written before provenance-aware replay. */
  schemaVersion?: number;
}

export interface IdempotencyReplayClaim {
  ledgerKey: string;
  stepId: string;
  traceSeq: number;
  /**
   * The claimed output was revoked through provenance, even if no currently
   * known literal occurs in the output. Retained until the matching trace is
   * durable so restart/reclaim cannot launder a derivative through replay.
   */
  outputSecretTainted?: boolean;
}

export interface IdempotencyLedgerStore {
  get(resolvedKey: string): Promise<IdempotencyLedgerEntry | undefined>;
  put(entry: IdempotencyLedgerEntry): Promise<void>;
  list(): Promise<IdempotencyLedgerEntry[]>;
  listByRun(runId: string): Promise<IdempotencyLedgerEntry[]>;
  delete(resolvedKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// AartStore — the full interface. 17 members (spec's 8 run-data + this
// architecture's 8 control-plane + `events`, added via the amendment
// protocol — AMENDMENTS.md A61), `transact()`, plus the two store-internal
// (non-counted) plumbing members above.
// ---------------------------------------------------------------------------

export interface AartStore {
  // 8 run-data members — spec §28.3, verbatim member names
  workflows: WorkflowStore;
  runs: RunStore;
  waits: WaitStore;
  signals: SignalStore;
  artifacts: ArtifactStore;
  approvals: ApprovalStore;
  corrections: CorrectionStore;
  evals: EvalStore;
  // 8 control-plane members — architecture-introduced, architecture §5
  deployments: DeploymentStore;
  environments: EnvironmentStore;
  schedules: ScheduleStore;
  promptRegistry: PromptRegistryStore;
  schemaRegistry: SchemaRegistryStore;
  packManifests: PackManifestStore;
  rejectedTriggers: RejectedTriggerStore;
  standingApprovals: StandingApprovalStore;
  // 17th member — V1 event log, added via the amendment protocol (AMENDMENTS.md A61)
  events: EventLogStore;
  // store-internal plumbing — not counted among the 17 (architecture §5.3/§5.7)
  jobQueue: JobQueueStore;
  idempotencyLedger: IdempotencyLedgerStore;
  /**
   * Cross-cutting unit-of-work method (architecture §5.8). Every read/write
   * performed through the `tx` view passed to `fn` either all commit
   * together or all roll back together — this is what makes architecture
   * §4.4.2's "dedupe-consumed + run-state-transition in a single store
   * transaction" claim implementable.
   *
   * SQLite/Postgres adapters implement this with a real BEGIN/COMMIT/
   * ROLLBACK. The fs adapter has no native cross-file transaction
   * primitive (architecture §5.8) — see adapters/fs/index.ts for its
   * concrete mechanism (buffer every write issued through `tx` in memory;
   * flush each touched file atomically via write-temp-then-rename only if
   * `fn` resolves; discard everything if `fn` throws) and, critically, its
   * documented non-atomic gap: `tx.signals` writes are NOT staged — they
   * always land immediately, independent of whether the rest of the
   * transaction ultimately commits. This is a deliberate, accepted gap for
   * local dev (fs adapter only), not an oversight — see the comment on
   * SignalStore.append/markConsumed above and adapters/fs/index.ts.
   *
   * `tx.events` (AMENDMENTS.md A61) follows the identical non-staged
   * pattern, for an analogous reason: every real write site appends its
   * event OUTSIDE of any `store.transact()` call (a best-effort, fire-
   * and-forget audit line via event-log.ts's `recordEvent`, never
   * expected to participate in the primary write's own atomicity), so
   * there is no caller today relying on an event append rolling back
   * alongside a failed transaction — see adapters/fs/events.ts.
   */
  transact<T>(fn: (tx: AartStore) => Promise<T>): Promise<T>;
}
