// The fs adapter (architecture §5.1 "Filesystem (.aart/) | Local dev (aart
// dev)") — implements every AartStore member against the .aart/ layout
// (architecture §5.2), including `transact()` via the staging-buffer
// mechanism (json-file.ts) and its documented non-atomic gap (the global
// signals audit copy — see types.ts's SignalStore doc comment and the note
// on `withStaging` below).
import type { AartStore } from "../../types.js";
import { realpathSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import { FsArtifactStore } from "./artifacts.js";
import { FsEventLogStore } from "./events.js";
import {
  createStagingBuffer,
  flushStagingBuffer,
  recoverStagingJournals,
  type StagingBuffer,
} from "./json-file.js";
import * as paths from "./paths.js";
import { FsRunStore } from "./runs.js";
import {
  FsApprovalStore,
  FsCorrectionStore,
  FsDeploymentStore,
  FsEnvironmentStore,
  FsEvalStore,
  FsIdempotencyLedgerStore,
  FsJobQueueStore,
  FsPackManifestStore,
  FsPromptRegistryStore,
  FsRejectedTriggerStore,
  FsScheduleStore,
  FsSchemaRegistryStore,
  FsStandingApprovalStore,
} from "./simple-stores.js";
import { FsSignalStore } from "./signals.js";
import { FsWaitStore } from "./waits.js";
import { FsWorkflowStore } from "./workflows.js";

class FsStoreMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {
      /* replaced below */
    };
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const rootMutexes = new Map<string, FsStoreMutex>();

function mutexForRoot(root: string): FsStoreMutex {
  const existing = rootMutexes.get(root);
  if (existing) return existing;
  const created = new FsStoreMutex();
  rootMutexes.set(root, created);
  return created;
}

function canonicalRootIdentity(root: string): string {
  const missingSegments: string[] = [];
  let candidate = resolve(root);

  for (;;) {
    try {
      return resolve(
        realpathSync.native(candidate),
        ...missingSegments,
      );
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(root);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function serializeMember<T extends object>(
  member: T,
  mutex: FsStoreMutex,
  root: string,
): T {
  return new Proxy(member, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        mutex.run(() => {
          recoverStagingJournals(root);
          return Reflect.apply(value, target, args);
        });
    },
  });
}

/**
 * Builds an `AartStore` object rooted at `root` (typically `.aart` inside a
 * project directory). `staging`, when supplied, routes every *staged*
 * member's writes through the shared in-memory buffer instead of disk —
 * this is exactly what `transact()` below uses to construct its `tx` view.
 * `signals` (architecture §5.8's documented gap) and `artifacts` (no
 * documented transactional requirement, and blobs are a poor fit for an
 * in-memory buffer) are deliberately excluded from staging: they always
 * write immediately, staged transaction or not.
 */
function buildStore(
  root: string,
  staging: StagingBuffer | undefined,
  mutex: FsStoreMutex,
): AartStore {
  // Top-level operations and whole transactions share one root-scoped
  // mutex, including across multiple createFsStore(root) handles in this
  // process. A transaction view is already inside that critical section,
  // so its members remain direct to avoid nested-lock deadlock.
  const serialized = <T extends object>(member: T): T =>
    staging === undefined
      ? serializeMember(member, mutex, root)
      : member;
  const store: AartStore = {
    workflows: serialized(
      new FsWorkflowStore(paths.registryWorkflowsDir(root), staging),
    ),
    runs: serialized(new FsRunStore(paths.runsDir(root), staging)),
    waits: serialized(new FsWaitStore(paths.waitsDir(root), staging)),
    // Not staged — see doc comment above.
    signals: serialized(new FsSignalStore(paths.signalsDir(root))),
    // Not staged — see doc comment above.
    artifacts: serialized(
      new FsArtifactStore(paths.artifactsDir(root)),
    ),
    approvals: serialized(
      new FsApprovalStore(paths.approvalsDir(root), staging),
    ),
    corrections: serialized(
      new FsCorrectionStore(paths.correctionsDir(root), staging),
    ),
    evals: serialized(
      new FsEvalStore(
        paths.evalSuitesDir(root),
        paths.evalExamplesDir(root),
        paths.evalRunsDir(root),
        staging,
      ),
    ),
    deployments: serialized(
      new FsDeploymentStore(paths.deploymentsDir(root), staging),
    ),
    environments: serialized(
      new FsEnvironmentStore(paths.environmentsDir(root), staging),
    ),
    schedules: serialized(
      new FsScheduleStore(paths.schedulesDir(root), staging),
    ),
    promptRegistry: serialized(
      new FsPromptRegistryStore(
        paths.registryPromptsDir(root),
        staging,
      ),
    ),
    schemaRegistry: serialized(
      new FsSchemaRegistryStore(
        paths.registrySchemasDir(root),
        staging,
      ),
    ),
    packManifests: serialized(
      new FsPackManifestStore(paths.registryPacksDir(root), staging),
    ),
    rejectedTriggers: serialized(
      new FsRejectedTriggerStore(
        paths.rejectedTriggersDir(root),
        staging,
      ),
    ),
    standingApprovals: serialized(
      new FsStandingApprovalStore(
        paths.standingApprovalsDir(root),
        staging,
      ),
    ),
    // Not staged — see doc comment above (mirrors signals/artifacts).
    events: serialized(new FsEventLogStore(paths.eventsDir(root))),
    jobQueue: serialized(
      new FsJobQueueStore(paths.jobQueueDir(root), staging),
    ),
    idempotencyLedger: serialized(
      new FsIdempotencyLedgerStore(
        paths.idempotencyDir(root),
        staging,
      ),
    ),
    async transact<T>(fn: (tx: AartStore) => Promise<T>): Promise<T> {
      // Nested transact() calls reuse the same buffer/view rather than
      // creating a fresh nested one — a transaction started from inside
      // another transaction's callback is just more work against the same
      // in-flight, not-yet-flushed buffer (there is nothing to roll back to
      // "in between," since nothing has been flushed yet either way).
      if (staging) {
        return fn(store);
      }
      return mutex.run(async () => {
        recoverStagingJournals(root);
        const txBuffer = createStagingBuffer();
        const tx = buildStore(root, txBuffer, mutex);
        const result = await fn(tx);
        // Only reached if `fn` resolved without throwing — an exception
        // propagates out of `transact()` with the buffer simply discarded
        // (never referenced again, never flushed), which is the "roll back
        // together" half of the contract.
        await flushStagingBuffer(txBuffer, root);
        return result;
      });
    },
  };
  return store;
}

export function createFsStore(root: string): AartStore {
  const normalizedRoot = canonicalRootIdentity(root);
  return buildStore(
    normalizedRoot,
    undefined,
    mutexForRoot(normalizedRoot),
  );
}
