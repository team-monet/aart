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
import { highestVersion } from "../version-compare.js";

export interface ClosureResult {
  /** Keyed by `${workflowId}@${version}` — the root plus every nested workflow reachable via `flow.subworkflow` steps. */
  workflows: Map<string, Workflow>;
  packNamespaces: Set<string>;
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

  const result: ClosureResult = { workflows: new Map(), packNamespaces: new Set(), promptRefNames: new Set(), schemaRefNames: new Set() };
  if (visited.has(key)) return result; // cycle guard — already in this walk
  visited.add(key);

  const workflow = await store.workflows.get(workflowId, version);
  if (!workflow) {
    throw new Error(`Bundle closure: workflow "${workflowId}@${version}" not found in the store.`);
  }
  result.workflows.set(key, workflow);

  for (const step of workflow.execution.steps) {
    const namespace = step.uses.split(".")[0];
    if (namespace) result.packNamespaces.add(namespace);

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
  for (const ns of source.packNamespaces) target.packNamespaces.add(ns);
  for (const p of source.promptRefNames) target.promptRefNames.add(p);
  for (const s of source.schemaRefNames) target.schemaRefNames.add(s);
}

export interface ResolvedClosure {
  workflows: Map<string, Workflow>;
  packs: Map<string, PackManifest>;
  prompts: Map<string, PromptRegistryEntry>;
  schemas: Map<string, SchemaRegistryEntry>;
}

/** Resolves `packNamespaces`/`promptRefNames`/`schemaRefNames` against the store's registries. A namespace with no registered `PackManifest` versions is treated as a core built-in (ships with the runtime binary itself, architecture §0.3 — nothing to bundle) rather than an error, since most namespaces (`browser`, `http`, `assert`, ...) are exactly that. */
export async function resolveClosureRegistryEntries(store: AartStore, closure: ClosureResult): Promise<ResolvedClosure> {
  const packs = new Map<string, PackManifest>();
  for (const namespace of closure.packNamespaces) {
    const versions = await store.packManifests.listVersions(namespace);
    const latest = highestVersion(versions);
    if (!latest) continue; // core built-in — not pack-delivered
    const manifest = await store.packManifests.get(namespace, latest);
    if (manifest) packs.set(`${namespace}@${latest}`, manifest);
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
