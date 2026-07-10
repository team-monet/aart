// Ties trigger type -> adapter handler + loads `TriggerBinding`s out of the
// already-frozen store records that can carry them (architecture ADR-06's
// `Deployment.triggerConfig` bag for the 12 non-schedule types; the
// dedicated `Schedule` store member for `schedule`, architecture §5.3) —
// see triggers/types.ts's module doc comment for why bindings aren't a new
// persisted entity this package invents.
import type { AartStore } from "@aart/store";
import type { Deployment } from "@aart/types";
import type { TriggerBinding } from "./types.js";

/**
 * Reads every `Deployment.triggerConfig` in the store and parses it as a
 * `TriggerBinding` (minus `id`/`type`/`workflowId`, which this function
 * fills in from the `Deployment` row itself — `triggerConfig`'s own
 * contents are adapter-specific fields only: `webhookPath`,
 * `webhookHmacSecretRef`, `pollUrl`, etc.). A `Deployment` with no
 * recognizable trigger fields in `triggerConfig` (e.g. one meant only for
 * manual/CLI/SDK/MCP invocation, which need no persisted config at all) is
 * skipped, not an error — those four adapter types don't require a
 * `TriggerBinding` to exist ahead of time; a caller invoking them supplies
 * `workflowId` directly.
 */
export async function loadTriggerBindingsFromDeployments(store: AartStore): Promise<TriggerBinding[]> {
  const deployments = await store.deployments.list();
  const bindings: TriggerBinding[] = [];
  for (const deployment of deployments) {
    const binding = deploymentToBinding(deployment);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

function deploymentToBinding(deployment: Deployment): TriggerBinding | undefined {
  const cfg = deployment.triggerConfig as Partial<TriggerBinding> & { type?: TriggerBinding["type"] };
  if (!cfg?.type) return undefined;
  return {
    ...cfg,
    id: deployment.id,
    type: cfg.type,
    workflowId: deployment.workflowId,
    workflowVersion: deployment.workflowVersion,
    deploymentId: deployment.id,
    mode: cfg.mode ?? "start",
  };
}

/** All `Schedule` rows adapted into `TriggerBinding`-shaped views for anything (mostly the ticker) that wants to treat a schedule uniformly with other bindings — the ticker (ticker/ticker.ts) primarily works with `Schedule` records directly, since they already carry every field needed and re-deriving a `TriggerBinding` loses nothing but also gains nothing there; this export exists for callers (e.g. a future dashboard listing "all configured triggers" across every type) that want one uniform list. */
export async function loadScheduleBindings(store: AartStore): Promise<TriggerBinding[]> {
  const schedules = await store.schedules.list();
  return schedules
    .filter((s) => !s.paused)
    .map((s) => ({
      id: s.id,
      type: "schedule" as const,
      workflowId: s.workflowId,
      workflowVersion: s.workflowVersion,
      mode: "start" as const,
      cron: s.cron,
      timezone: s.timezone,
      missedRunPolicy: s.missedRunPolicy,
    }));
}
