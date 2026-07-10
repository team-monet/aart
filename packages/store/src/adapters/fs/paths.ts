// .aart/ fs layout — architecture §5.2, elaborated. One JSON file per
// record, directory-per-collection. `job-queue/` is not explicitly listed
// in architecture §5.2's own layout block (an apparent gap — job_queue is
// elsewhere stated as required "from day one," architecture §4.7/§5.3, so
// it needs *some* fs home); this module adds it following the same
// directory-per-collection convention as everything else here. See this
// task's final report for the fuller note.
import { join } from "node:path";

export function schemaVersionFile(root: string): string {
  return join(root, "schema-version.json");
}

export function registryWorkflowsDir(root: string): string {
  return join(root, "registry", "workflows");
}
export function registryPacksDir(root: string): string {
  return join(root, "registry", "packs");
}
export function registryPromptsDir(root: string): string {
  return join(root, "registry", "prompts");
}
export function registrySchemasDir(root: string): string {
  return join(root, "registry", "schemas");
}

export function runsDir(root: string): string {
  return join(root, "runs");
}
export function waitsDir(root: string): string {
  return join(root, "waits");
}
export function signalsDir(root: string): string {
  return join(root, "signals");
}
export function artifactsDir(root: string): string {
  return join(root, "artifacts");
}
export function approvalsDir(root: string): string {
  return join(root, "approvals");
}
export function standingApprovalsDir(root: string): string {
  return join(root, "standing-approvals");
}
export function rejectedTriggersDir(root: string): string {
  return join(root, "rejected-triggers");
}
export function schedulesDir(root: string): string {
  return join(root, "schedules");
}
export function environmentsDir(root: string): string {
  return join(root, "environments");
}
export function deploymentsDir(root: string): string {
  return join(root, "deployments");
}
export function correctionsDir(root: string): string {
  return join(root, "corrections");
}
export function evalSuitesDir(root: string): string {
  return join(root, "evals", "suites");
}
export function evalExamplesDir(root: string): string {
  return join(root, "evals", "examples");
}
export function evalRunsDir(root: string): string {
  return join(root, "evals", "runs");
}
export function idempotencyDir(root: string): string {
  return join(root, "idempotency");
}
// See module doc comment above.
export function jobQueueDir(root: string): string {
  return join(root, "job-queue");
}

export function migrationsWatermarkFile(root: string): string {
  return schemaVersionFile(root);
}
