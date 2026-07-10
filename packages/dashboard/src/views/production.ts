// v3 production additions (architecture §13.3): environments, deployments,
// trigger configs (derived from Deployment.triggerConfig, per S2's own
// SEAMS.md note: "every [trigger binding] type is read out of
// Deployment.triggerConfig"), secrets status (values NEVER shown —
// redaction chokepoint applies here too, §7.9), worker health (ADR-16,
// polled per registered worker).
import type { Deployment, Environment } from "@aart/types";
import type { HealthPayload } from "../api-client.js";
import { escapeHtml, page, table } from "../http/html.js";

export function renderEnvironmentsPage(environments: Environment[]): string {
  const rows = environments.map((e) => [escapeHtml(e.id), escapeHtml(e.name), escapeHtml(JSON.stringify(e.config))]);
  return page("Environments", table(["Id", "Name", "Config"], rows));
}

export function renderDeploymentsPage(deployments: Deployment[]): string {
  const rows = deployments.map((d) => [escapeHtml(d.id), escapeHtml(d.workflowId), escapeHtml(d.workflowVersion), escapeHtml(d.environmentId), escapeHtml(d.bundleHash ?? ""), escapeHtml(d.createdAt)]);
  return page("Deployments", table(["Id", "Workflow", "Version", "Environment", "Bundle Hash", "Created"], rows));
}

export function renderTriggerConfigsPage(deployments: Deployment[]): string {
  const rows = deployments
    .filter((d) => Object.keys(d.triggerConfig).length > 0)
    .map((d) => [escapeHtml(d.id), escapeHtml(d.workflowId), escapeHtml(d.environmentId), escapeHtml(JSON.stringify(d.triggerConfig))]);
  return page("Trigger Configs", table(["Deployment", "Workflow", "Environment", "Trigger Config"], rows));
}

/**
 * Secrets status: names/binding-state ONLY, never values — architecture
 * §13.3's `[DECISION]` + the redaction chokepoint (§7.9) apply here too.
 * `Environment.secretSource` (frozen shape: `Record<string, unknown>`) is
 * treated as a NAME -> adapter-config map; this renders only the key names
 * and whether a source is configured, never `JSON.stringify`-ing the
 * adapter config value itself (which could itself embed a credential).
 */
export function renderSecretsStatusPage(environments: Environment[]): string {
  const rows = environments.flatMap((e) => {
    const names = Object.keys(e.secretSource ?? {});
    if (names.length === 0) return [[escapeHtml(e.name), "(none configured)", "—"]];
    return names.map((name) => [escapeHtml(e.name), escapeHtml(name), "bound"]);
  });
  return page("Secrets Status", table(["Environment", "Secret Name", "Status"], rows));
}

export interface WorkerHealthEntry {
  url: string;
  health: HealthPayload | { error: string };
}

export function renderWorkerHealthPage(workers: WorkerHealthEntry[]): string {
  const rows = workers.map((w) => {
    if ("error" in w.health) return [escapeHtml(w.url), "unreachable", escapeHtml(w.health.error), "", ""];
    return [escapeHtml(w.url), escapeHtml(w.health.status), `${w.health.claimedRuns}`, `${w.health.uptime.toFixed(0)}s`, escapeHtml(w.health.version)];
  });
  return page("Worker Health", table(["Worker", "Status", "Claimed Runs / Error", "Uptime", "Version"], rows));
}
