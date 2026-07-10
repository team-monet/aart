// The fs adapter (architecture §5.1 "Filesystem (.aart/) | Local dev (aart
// dev)") — implements every AartStore member against the .aart/ layout
// (architecture §5.2), including `transact()` via the staging-buffer
// mechanism (json-file.ts) and its documented non-atomic gap (the global
// signals audit copy — see types.ts's SignalStore doc comment and the note
// on `withStaging` below).
import type { AartStore } from "../../types.js";
import { FsArtifactStore } from "./artifacts.js";
import { createStagingBuffer, flushStagingBuffer, type StagingBuffer } from "./json-file.js";
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
function buildStore(root: string, staging: StagingBuffer | undefined): AartStore {
  const store: AartStore = {
    workflows: new FsWorkflowStore(paths.registryWorkflowsDir(root), staging),
    runs: new FsRunStore(paths.runsDir(root), staging),
    waits: new FsWaitStore(paths.waitsDir(root), staging),
    // Not staged — see doc comment above.
    signals: new FsSignalStore(paths.signalsDir(root)),
    // Not staged — see doc comment above.
    artifacts: new FsArtifactStore(paths.artifactsDir(root)),
    approvals: new FsApprovalStore(paths.approvalsDir(root), staging),
    corrections: new FsCorrectionStore(paths.correctionsDir(root), staging),
    evals: new FsEvalStore(paths.evalSuitesDir(root), paths.evalExamplesDir(root), paths.evalRunsDir(root), staging),
    deployments: new FsDeploymentStore(paths.deploymentsDir(root), staging),
    environments: new FsEnvironmentStore(paths.environmentsDir(root), staging),
    schedules: new FsScheduleStore(paths.schedulesDir(root), staging),
    promptRegistry: new FsPromptRegistryStore(paths.registryPromptsDir(root), staging),
    schemaRegistry: new FsSchemaRegistryStore(paths.registrySchemasDir(root), staging),
    packManifests: new FsPackManifestStore(paths.registryPacksDir(root), staging),
    rejectedTriggers: new FsRejectedTriggerStore(paths.rejectedTriggersDir(root), staging),
    standingApprovals: new FsStandingApprovalStore(paths.standingApprovalsDir(root), staging),
    jobQueue: new FsJobQueueStore(paths.jobQueueDir(root), staging),
    idempotencyLedger: new FsIdempotencyLedgerStore(paths.idempotencyDir(root), staging),
    async transact<T>(fn: (tx: AartStore) => Promise<T>): Promise<T> {
      // Nested transact() calls reuse the same buffer/view rather than
      // creating a fresh nested one — a transaction started from inside
      // another transaction's callback is just more work against the same
      // in-flight, not-yet-flushed buffer (there is nothing to roll back to
      // "in between," since nothing has been flushed yet either way).
      if (staging) {
        return fn(store);
      }
      const txBuffer = createStagingBuffer();
      const tx = buildStore(root, txBuffer);
      const result = await fn(tx);
      // Only reached if `fn` resolved without throwing — an exception
      // propagates out of `transact()` with the buffer simply discarded
      // (never referenced again, never flushed), which is the "roll back
      // together" half of the contract.
      await flushStagingBuffer(txBuffer);
      return result;
    },
  };
  return store;
}

export function createFsStore(root: string): AartStore {
  return buildStore(root, undefined);
}
