// planBundleIngest() — D1 "remotes + push" (AMENDMENTS.md A56), D-5 of the
// design memo: `POST /bundles/plan`'s dry-run preview. Reuses the EXACT
// same envelope-parsing + hash-verification path `POST /bundles/ingest`
// uses (readBundleFromEnvelope) and the exact same target-environment
// resolution `hydrateBundle` uses (resolveHydrationTarget) — a plan that
// resolved either of those differently from what a real ingest would do
// would defeat the entire point of a preview — but STOPS before
// `store.transact()`: this function performs ZERO writes, full stop. Every
// field is computed by READING the store's current state and the bundle's
// own (not-yet-written) content, never mutating either.
import type { AartStore } from "@aart/store";
import type { Gates } from "@aart/types";
import type { GateName } from "@aart/governance";
import type { Bundle } from "./bundle.js";
import { BUNDLE_ENVIRONMENT, resolveHydrationTarget } from "./load.js";
import { evaluatePromotionForEnvironment, requiredGatesForEnvironment } from "../promotion.js";

export interface BundlePlanResult {
  ok: true;
  workflowId: string;
  workflowVersion: string;
  targetEnvironment?: string;
  /** The workflow VERSION currently active (promoted !== false) for this workflowId in the resolved target environment, if any — the most-recently-created such Deployment row when more than one exists (this system allows a Deployment row per version ever promoted/hydrated into an environment, not just one). Omitted when nothing is currently active there. */
  currentVersion?: string;
  /** Every `${workflowId}@${version}` in the bundle's FULL transitive closure (root + every nested workflow reference, bundle.ts's own `definitions` shape) — `added` doesn't exist in the destination store at all yet; `unchanged` already does (workflow versions are immutable by this system's own convention, so an existing id@version is definitionally the same content — no deep comparison needed). */
  versionsChanging: { added: string[]; unchanged: string[] };
  /** Would ingesting this bundle actually result in a LIVE, fireable trigger — the same two conditions `deploymentToBinding` (triggers/registry.ts) itself checks: the resulting Deployment's `promoted` stamp would be non-`false`, AND `triggers.json` carries a recognizable `type`. */
  triggersWouldActivate: boolean;
  /**
   * Step-level `uses:` diff between the bundle's NEW root workflow version
   * and `currentVersion`'s (when one exists) — added/removed distinct
   * `uses` strings. Deliberately NOT a resolved capability-TIER diff (the
   * kind `@aart/governance`'s real `semanticRiskDiff` computes when fed a
   * live block registry, `@aart/mcp`'s `real-context.ts`): `@aart/server`
   * has no block catalog to resolve a `uses` id to its declared
   * capabilities (multiple different `uses` values can share one
   * capability — e.g. every `browser.*` block declares the same `browser`
   * capability, root AMENDMENTS.md A24) — this is the best signal
   * computable from stored data alone, still genuinely useful ("this
   * version now uses `command.run`, which the currently-active one
   * didn't"), just a structural approximation, not a formal risk-tier
   * verdict. Present only when a `currentVersion` exists to diff against.
   */
  capabilityDiff?: { added: string[]; removed: string[] };
  /** The bundle's OWN root workflow's gate snapshot, exactly as sealed into the bundle (governance is deliberately not re-run — bundle.ts's/load.ts's own established doc comments) — what you see is what ingest would write verbatim. */
  gateStatus: Gates;
  /** Would a promotion evaluation against the resolved target environment's required gates succeed RIGHT NOW, using this bundle's own approval/gates — computed with the SAME evaluatePromotionForEnvironment/requiredGatesForEnvironment functions promoteWorkflowVersionToEnvironment itself uses (promotion.ts). Note this is INDEPENDENT of `triggersWouldActivate`/ingest's own `promoted` stamp — ingest never re-runs this evaluation (governance not re-run on ingest, by design); this field exists purely to tell an operator "if I promoted this after ingesting, would it succeed." */
  promotionEligible: boolean;
  /** Every required gate this environment demands that the bundle's own gates don't (yet) satisfy — the full required set when promotion is blocked outright (workflow.promotionBlocked), since nothing can be considered satisfied while blocked. Empty when promotionEligible is true. */
  unmetGates: GateName[];
  /** Plain-English, actionable next steps — empty when there's nothing to remedy (promotionEligible && triggersWouldActivate). */
  remedies: string[];
}

function findRootDefinition(bundle: Bundle) {
  const key = `${bundle.manifest.workflowId}@${bundle.manifest.workflowVersion}`;
  const workflow = bundle.definitions[key];
  if (!workflow) {
    throw new Error(`Bundle plan: root workflow "${key}" is missing from this bundle's own definitions closure — a structurally invalid bundle (readBundleFromEnvelope should have already rejected this).`);
  }
  return workflow;
}

/** The most-recently-created Deployment row for (workflowId, environmentId) whose `promoted` is not explicitly `false` — see `BundlePlanResult.currentVersion`'s own doc comment for why "most recent" is this function's tie-break heuristic rather than a hard single-row invariant. */
async function findCurrentVersion(store: AartStore, workflowId: string, environmentId: string): Promise<string | undefined> {
  const deployments = await store.deployments.list({ environmentId, workflowId });
  const active = deployments.filter((d) => d.promoted !== false);
  if (active.length === 0) return undefined;
  const latest = [...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return latest?.workflowVersion;
}

function usesSet(steps: ReadonlyArray<{ uses: string }>): Set<string> {
  return new Set(steps.map((s) => s.uses));
}

export async function planBundleIngest(store: AartStore, bundle: Bundle): Promise<BundlePlanResult> {
  const { workflowId, workflowVersion, targetEnvironment: targetEnvironmentName } = bundle.manifest;
  const target = await resolveHydrationTarget(store, targetEnvironmentName);
  const environment = target?.environment ?? BUNDLE_ENVIRONMENT;

  // versionsChanging — the bundle's FULL closure, not just the root.
  const added: string[] = [];
  const unchanged: string[] = [];
  for (const key of Object.keys(bundle.definitions)) {
    const [defWorkflowId, defVersion] = key.split("@");
    const existing = await store.workflows.get(defWorkflowId!, defVersion!);
    (existing ? unchanged : added).push(key);
  }

  const rootWorkflow = findRootDefinition(bundle);
  const currentVersion = await findCurrentVersion(store, workflowId, environment.id);

  let capabilityDiff: BundlePlanResult["capabilityDiff"];
  if (currentVersion !== undefined && currentVersion !== workflowVersion) {
    const previous = await store.workflows.get(workflowId, currentVersion);
    if (previous) {
      const previousUses = usesSet(previous.execution.steps);
      const newUses = usesSet(rootWorkflow.execution.steps);
      capabilityDiff = {
        added: [...newUses].filter((u) => !previousUses.has(u)).sort(),
        removed: [...previousUses].filter((u) => !newUses.has(u)).sort(),
      };
    }
  }

  const required = requiredGatesForEnvironment(environment);
  const evaluation = evaluatePromotionForEnvironment({
    workflow: { promotionBlocked: rootWorkflow.promotionBlocked },
    globalApproval: rootWorkflow.approval,
    gates: rootWorkflow.gates,
    requiredGatesForEnvironment: required,
    environment: environment.id,
  });
  const promotionEligible = !evaluation.blocked && evaluation.record.promoted;
  const unmetGates: GateName[] = evaluation.blocked ? [...required] : [...evaluation.record.unmetGates];

  // triggersWouldActivate — the SAME two conditions deploymentToBinding
  // itself checks (triggers/registry.ts): promoted !== false, and
  // triggers.json carries a recognizable `type`.
  const wouldBePromoted = target ? target.promoted : true; // legacy fallback: promoted left unset -> active, hydrateBundle's own documented behavior
  const triggerType = (bundle.triggers as { type?: unknown } | null)?.type;
  const triggersWouldActivate = wouldBePromoted && typeof triggerType === "string" && triggerType.length > 0;

  const remedies: string[] = [];
  if (evaluation.blocked) {
    remedies.push(`Workflow "${workflowId}@${workflowVersion}" has promotion explicitly blocked (workflow.promotionBlocked) — clear it before it can be promoted in this environment.`);
  } else if (!promotionEligible) {
    remedies.push(`Required gate(s) not yet satisfied for "${environment.name}": ${unmetGates.join(", ")}. Satisfy them, then promote — "aart promote ${workflowId} --version ${workflowVersion}" or POST /workflows/${workflowId}/promote.`);
  }
  if (!triggersWouldActivate && wouldBePromoted === false) {
    remedies.push(`Ingesting will record this as evidence but leave it inactive (promoted:false) for "${environment.name}" — promote it explicitly once ready: "aart promote ${workflowId} --version ${workflowVersion}".`);
  }

  return {
    ok: true,
    workflowId,
    workflowVersion,
    ...(targetEnvironmentName ? { targetEnvironment: targetEnvironmentName } : {}),
    ...(currentVersion !== undefined ? { currentVersion } : {}),
    versionsChanging: { added, unchanged },
    triggersWouldActivate,
    ...(capabilityDiff ? { capabilityDiff } : {}),
    gateStatus: rootWorkflow.gates,
    promotionEligible,
    unmetGates,
    remedies,
  };
}
