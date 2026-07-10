// ExecutionSnapshot capture (architecture §4.5, spec §19.1). Captured once
// per run, at the earlier of (a) first wait or (b) run completion, by
// walking the resolved `Workflow` + (v1 scope note below) computing
// resolvedVersions from this engine instance's own block registry.
import type { AartStore } from "@aart/store";
import { WorkflowSchema, type ExecutionSnapshot, type Workflow } from "@aart/types";
import type { BlockRegistry } from "./types.js";

/**
 * `[DECISION]` `definitions` is captured as the resolved `Workflow` object
 * itself (JSON-serializable, matching `WorkflowSchema` exactly) — this is
 * the "workflow" half of architecture §4.5's "workflow + referenced
 * blocks/packs" definition tree. The "referenced blocks/packs" half (a full
 * transitive closure walk of every block/pack source the workflow touches)
 * is explicitly flagged by architecture §0.3/ADR-04's own consequences note
 * as overlapping with `aart bundle`'s closure-computation logic (S2's
 * scope) and a coordination point between the two, not something this
 * session's DoD requires in full — this session's own DoD only requires
 * `resolvedVersions`/`packHashes` to be CORRECT for a fixture referencing a
 * floating-version block, which this implementation satisfies via the
 * engine's own block registry (a real, correct source for "what version is
 * this block reference currently resolved to," since the registry IS the
 * concrete resolved set of block implementations this engine instance
 * dispatches against).
 *
 * `packHashes` (S9 integration, root AMENDMENTS.md/reconciliation ledger
 * item 8): computed via the optional `EngineConfig.computePackHashes` DI
 * seam (types.ts), the same "process-lifetime injected function, sensible
 * no-op default" pattern `redact`/`capabilityCheck`/`getGrantedCapabilities`
 * already use. Defaults to `alwaysEmptyPackHashes` (this file) — an empty
 * record, today's pre-integration behavior, so any caller/test that hasn't
 * wired pack hashing keeps working unchanged. The frozen `BlockManifest`
 * (@aart/types) carries no pack-provenance field (verified directly — no
 * `packName` on the type), so THIS function cannot itself tell which
 * `step.uses` block ids are pack-delivered; that knowledge lives only in
 * whoever assembled `blocks` (the composition root merging @aart/blocks-core's
 * core catalog with @aart/registry's pack-manifest-derived blocks) — hence
 * the caller-supplied-function shape rather than this module trying to
 * derive it from `blocks` alone. The real composition-root wiring
 * (@aart/registry's `computePackContentHash`, hash.ts) is S9's composition
 * root, not this package's own tests.
 */
const UNCAPTURED_SNAPSHOT: ExecutionSnapshot = { definitions: null, resolvedVersions: {}, packHashes: {}, capturedAt: "" };

/** Default `computePackHashes` — no pack-provenance data available, matching this field's pre-integration empty-record behavior exactly. */
export async function alwaysEmptyPackHashes(): Promise<Record<string, string>> {
  return {};
}

/** Computes the content hash of every pack a workflow's steps reference. Caller-supplied (see module doc comment above) rather than derived here, since the frozen `BlockManifest` carries no pack-provenance field. */
export type ComputePackHashes = (workflow: Workflow, blocks: BlockRegistry) => Promise<Record<string, string>>;

/** A `RunRecord.snapshot` value indicating "not yet captured" — every `RunRecord` must have SOME `snapshot` value (the field is non-optional on the frozen type), so this sentinel (`capturedAt: ""`) is what a freshly-created run starts with. */
export function uncapturedSnapshot(): ExecutionSnapshot {
  return { ...UNCAPTURED_SNAPSHOT };
}

export function isSnapshotCaptured(snapshot: ExecutionSnapshot): boolean {
  return snapshot.capturedAt !== "";
}

/**
 * Walks `workflow.execution.steps[].uses`, resolving each referenced block
 * id's CURRENT version from `blocks` (this engine instance's own registry)
 * — this is "the concrete version resolved for every reference that could
 * have floated" (spec §19.1) for every block id this engine can actually
 * resolve. A step referencing a block id not present in `blocks` (e.g. a
 * `wait.*`/`human.*` id, which this engine handles structurally rather than
 * via a registered `BlockImplementation` — see `wait/wait-blocks.ts`) is
 * simply omitted from `resolvedVersions`, not an error.
 */
function computeResolvedVersions(workflow: Workflow, blocks: BlockRegistry): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const step of workflow.execution.steps) {
    const impl = blocks[step.uses];
    if (impl) {
      resolved[step.uses] = impl.manifest.version;
    }
  }
  return resolved;
}

export async function captureExecutionSnapshot(
  workflow: Workflow,
  blocks: BlockRegistry,
  now: Date,
  computePackHashes: ComputePackHashes = alwaysEmptyPackHashes,
): Promise<ExecutionSnapshot> {
  return {
    definitions: workflow,
    resolvedVersions: computeResolvedVersions(workflow, blocks),
    packHashes: await computePackHashes(workflow, blocks),
    capturedAt: now.toISOString(),
  };
}

/**
 * Resolves the `Workflow` a run's steps should continue from: the run's own
 * frozen snapshot if one has been captured (architecture §4.5 — "the
 * snapshot is the 'as it ran' world, frozen apart from the store's 'as it
 * is now' world"; this is what makes rollback/promotion of a NEWER version
 * not retroactively affect an in-flight run, architecture §0.2), otherwise
 * the live `store.workflows` entry (a run that hasn't reached its first
 * wait yet has nothing frozen to diverge from).
 */
export async function resolveWorkflowForRun(store: AartStore, run: { workflowId: string; workflowVersion: string; snapshot: ExecutionSnapshot }): Promise<Workflow> {
  if (isSnapshotCaptured(run.snapshot) && run.snapshot.definitions !== null) {
    return WorkflowSchema.parse(run.snapshot.definitions);
  }
  const workflow = await store.workflows.get(run.workflowId, run.workflowVersion);
  if (!workflow) {
    throw new Error(`No workflow found in the store for ${run.workflowId}@${run.workflowVersion} — cannot resolve step definitions.`);
  }
  return workflow;
}
