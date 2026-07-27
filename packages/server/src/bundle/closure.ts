// Transitive-closure computation for `aart bundle` (architecture §0.3,
// ADR-04) — "every referenced block/pack/registry entry." This session's
// DoD names the exact bug class this must catch: "test this against a
// fixture workflow with at least 2 levels of block-reference nesting to
// catch an incomplete-closure bug."
//
// Nested-workflow convention: neither document gives an exact syntax for
// "a workflow-type block containing steps using further blocks" (architecture
// §7.4's own phrase) beyond that the closure walk must follow it. This
// module recognizes `uses: "flow.subworkflow"` with `with: { workflowId,
// version? }` (matching `flow.*` as one of blocks-core's own core-builtin
// namespaces, spec §15.2/§15.3's "Flow" group) as the nested-workflow
// reference shape — documented, flagged interpretation (see this task's
// final report) rather than a convention either source document states
// verbatim.
import type { AartStore } from "@aart/store";
import type { PackManifest, PromptRegistryEntry, SchemaRegistryEntry, Workflow } from "@aart/types";
import { listActiveApprovedPackStatesSync } from "@aart/registry";
import { highestVersion } from "../version-compare.js";

export interface ClosureResult {
  /** Keyed by `${workflowId}@${version}` — the root plus every nested workflow reachable via `flow.subworkflow` steps. */
  workflows: Map<string, Workflow>;
  /** Exact block ids referenced by the workflow closure. Pack ownership is resolved from manifests, never inferred from an id prefix. */
  blockIds: Set<string>;
  /** `name` (unversioned — always resolved to the latest version present in the store at bundle-production time, then pinned into the manifest, matching ExecutionSnapshot's own "resolvedVersions" pattern, architecture §4.5). */
  promptRefNames: Set<string>;
  schemaRefNames: Set<string>;
}

function workflowKey(workflowId: string, version: string): string {
  return `${workflowId}@${version}`;
}

async function resolveVersion(store: AartStore, workflowId: string, version: string | undefined): Promise<string> {
  if (version && version !== "latest") return version;
  const versions = await store.workflows.listVersions(workflowId);
  const latest = highestVersion(versions);
  if (!latest) throw new Error(`Bundle closure: workflow "${workflowId}" has no versions in the store.`);
  return latest;
}

export async function computeClosure(store: AartStore, workflowId: string, requestedVersion: string | undefined, visited: Set<string> = new Set()): Promise<ClosureResult> {
  const version = await resolveVersion(store, workflowId, requestedVersion);
  const key = workflowKey(workflowId, version);

  const result: ClosureResult = { workflows: new Map(), blockIds: new Set(), promptRefNames: new Set(), schemaRefNames: new Set() };
  if (visited.has(key)) return result; // cycle guard — already in this walk
  visited.add(key);

  const workflow = await store.workflows.get(workflowId, version);
  if (!workflow) {
    throw new Error(`Bundle closure: workflow "${workflowId}@${version}" not found in the store.`);
  }
  result.workflows.set(key, workflow);

  for (const step of workflow.execution.steps) {
    const namespace = step.uses.split(".")[0];
    result.blockIds.add(step.uses);

    if (step.uses === "flow.subworkflow") {
      const nestedId = step.with?.["workflowId"];
      const nestedVersion = step.with?.["version"];
      if (typeof nestedId === "string") {
        const sub = await computeClosure(store, nestedId, typeof nestedVersion === "string" ? nestedVersion : undefined, visited);
        mergeClosureInto(result, sub);
      }
    }

    if (namespace === "llm" && step.with) {
      const promptRef = step.with["promptRef"];
      const schemaRef = step.with["schemaRef"];
      if (typeof promptRef === "string") result.promptRefNames.add(promptRef);
      if (typeof schemaRef === "string") result.schemaRefNames.add(schemaRef);
    }
  }

  return result;
}

function mergeClosureInto(target: ClosureResult, source: ClosureResult): void {
  for (const [k, v] of source.workflows) target.workflows.set(k, v);
  for (const blockId of source.blockIds) target.blockIds.add(blockId);
  for (const p of source.promptRefNames) target.promptRefNames.add(p);
  for (const s of source.schemaRefNames) target.schemaRefNames.add(s);
}

export interface ResolvedClosure {
  workflows: Map<string, Workflow>;
  packs: Map<string, PackManifest>;
  prompts: Map<string, PromptRegistryEntry>;
  schemas: Map<string, SchemaRegistryEntry>;
}

/**
 * Resolves exact referenced block ids against the active approved Pack
 * manifests. A block with no Pack owner is a core built-in and needs no
 * bundled manifest.
 */
export async function resolveClosureRegistryEntries(
  store: AartStore,
  closure: ClosureResult,
  options: { packRoot?: string } = {},
): Promise<ResolvedClosure> {
  const packs = new Map<string, PackManifest>();
  const activeManifests = await resolveActivePackManifests(store, options.packRoot);
  const ownerByBlockId = new Map<string, PackManifest>();
  for (const manifest of activeManifests) {
    const blockIds = Array.isArray(manifest.manifest["blocks"])
      ? manifest.manifest["blocks"].filter((id): id is string => typeof id === "string")
      : [];
    for (const blockId of blockIds) {
      const existing = ownerByBlockId.get(blockId);
      if (existing && existing.name !== manifest.name) {
        throw new Error(
          `Bundle closure: block "${blockId}" is claimed by multiple active approved Packs ` +
            `("${existing.name}" and "${manifest.name}").`,
        );
      }
      ownerByBlockId.set(blockId, manifest);
    }
  }
  for (const blockId of closure.blockIds) {
    const owner = ownerByBlockId.get(blockId);
    if (owner) packs.set(`${owner.name}@${owner.version}`, owner);
  }

  const prompts = new Map<string, PromptRegistryEntry>();
  for (const name of closure.promptRefNames) {
    const versions = await store.promptRegistry.listVersions(name);
    const latest = highestVersion(versions);
    if (!latest) continue;
    const entry = await store.promptRegistry.get(name, latest);
    if (entry) prompts.set(`${name}@${latest}`, entry);
  }

  const schemas = new Map<string, SchemaRegistryEntry>();
  for (const name of closure.schemaRefNames) {
    const versions = await store.schemaRegistry.listVersions(name);
    const latest = highestVersion(versions);
    if (!latest) continue;
    const entry = await store.schemaRegistry.get(name, latest);
    if (entry) schemas.set(`${name}@${latest}`, entry);
  }

  return { workflows: closure.workflows, packs, prompts, schemas };
}

async function resolveActivePackManifests(store: AartStore, packRoot: string | undefined): Promise<PackManifest[]> {
  if (packRoot) {
    const manifests: PackManifest[] = [];
    for (const state of listActiveApprovedPackStatesSync(packRoot)) {
      const manifest = await store.packManifests.get(state.name, state.version);
      if (
        !manifest ||
        manifest.approvalStatus !== "approved" ||
        manifest.contentHash !== state.contentHash
      ) {
        throw new Error(
          `Bundle closure: active Pack "${state.name}@${state.version}" does not match an approved store manifest.`,
        );
      }
      manifests.push(manifest);
    }
    return manifests;
  }

  const manifests: PackManifest[] = [];
  for (const name of await store.packManifests.listNames()) {
    const approved: PackManifest[] = [];
    for (const version of await store.packManifests.listVersions(name)) {
      const manifest = await store.packManifests.get(name, version);
      if (manifest?.approvalStatus === "approved") approved.push(manifest);
    }
    const latestApprovedVersion = highestVersion(approved.map((manifest) => manifest.version));
    const latestApproved = approved.find((manifest) => manifest.version === latestApprovedVersion);
    if (latestApproved) manifests.push(latestApproved);
  }
  return manifests;
}
