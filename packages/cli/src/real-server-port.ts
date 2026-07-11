// createRealServerPort — the REAL ServerPort (AMENDMENTS.md A42; see
// real-context.ts's module doc comment for the corrected story A37 left
// stale). Mirrors stubs/server.ts's documented exports one-for-one, each
// now backed by @aart/server's real, already-complete machinery instead of
// a simplified stand-in:
//   - startServer/startWorker <- @aart/server's real startServer/startWorker,
//     fed a real EngineBoundary (createRealEngineBoundary) over the SAME
//     Engine instance cli-context.ts's createRealAartContextWithEngine call
//     already built for this same process's AartContext — one Engine, one
//     store, shared by every port/command in one CLI invocation, never two
//     divergent ones. AMENDMENTS.md A45: startServer now also wires a real
//     secretResolver (secrets.ts — the piece A44 found missing, so webhook/
//     github/slack HMAC verification can actually succeed) and resolves
//     `config.environment`'s human-readable name into the `environmentId`
//     ServerConfig scopes trigger-binding activation by.
//   - produceBundle <- @aart/server's real produceBundle (the actual
//     transitive-closure bundle production, packages/server/src/bundle/
//     bundle.ts), bridged: ServerPort.produceBundle's `environment?: string`
//     is a NAME (what a human types after `--environment`); the real
//     function wants an optional `Deployment` record. resolveDeployment
//     below does that name -> Deployment lookup (environments.getByName,
//     then deployments.list scoped to that environment+workflow), throwing
//     a clear error only when the NAMED ENVIRONMENT doesn't exist at all —
//     an environment that exists but has no deployment for this workflow
//     yet is not an error (produceBundle's own `deployment` param is
//     documented optional: "omit for a bare workflow-closure bundle").
//     The real function's richer `Bundle` return (definitions/packs/
//     registry/triggers, content-addressed bundleHash) is then flattened
//     into ServerPort's flatter `BundleLike` (manifest + a relPath->content
//     `files` map) using the exact same on-disk layout @aart/server's own
//     writeBundleToDisk uses (architecture §0.3) — so the file this
//     package's writeBundleToDisk (via the shared bundle-files.ts helper)
//     ends up writing is byte-for-byte what a direct @aart/server caller
//     would have written, just assembled in memory first to satisfy
//     ServerPort's shape.
//   - clearRunFlag/listFlaggedRuns <- @aart/server's real flags.ts exports
//     (the stub already reimplemented these correctly against the real,
//     frozen RunRecord.flag field — this just delegates to the canonical
//     implementation instead of a second copy of the same logic).
import type { Deployment } from "@aart/types";
import type { AartStore } from "@aart/store";
import type { BundleLike, ClearRunFlagResult, Engine, ServerHandleLike, ServerPort, WorkerHandleLike } from "@aart/mcp";
import {
  clearRunFlag as realClearRunFlag,
  createRealEngineBoundary,
  listFlaggedRuns as realListFlaggedRuns,
  produceBundle as produceRealBundle,
  startServer as startRealServer,
  startWorker as startRealWorker,
  type Bundle,
} from "@aart/server";
import { writeBundleFilesToDisk } from "./bundle-files.js";
import { createRealSecretResolver } from "./secrets.js";

function sanitizeFilename(key: string): string {
  return key.replace(/[/\\:*?"<>|]/g, "_");
}

/** Same on-disk layout as @aart/server's own writeBundleToDisk (packages/server/src/bundle/bundle.ts) — see this file's module doc comment for why this package can't just call that function directly (it writes a real `Bundle`, not ServerPort's flatter `BundleLike`). */
function bundleToBundleLike(bundle: Bundle): BundleLike {
  const files: Record<string, string> = {
    "manifest.json": JSON.stringify(bundle.manifest, null, 2),
    "triggers.json": JSON.stringify(bundle.triggers, null, 2),
  };
  for (const [key, workflow] of Object.entries(bundle.definitions)) {
    files[`definitions/${sanitizeFilename(key)}.json`] = JSON.stringify(workflow, null, 2);
  }
  for (const [key, manifest] of Object.entries(bundle.packs)) {
    files[`packs/${sanitizeFilename(key)}.json`] = JSON.stringify(manifest, null, 2);
  }
  for (const [key, entry] of Object.entries(bundle.registry.prompts)) {
    files[`registry/prompts/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  }
  for (const [key, entry] of Object.entries(bundle.registry.schemas)) {
    files[`registry/schemas/${sanitizeFilename(key)}.json`] = JSON.stringify(entry, null, 2);
  }
  return { manifest: bundle.manifest as unknown as Record<string, unknown>, files };
}

/** `aart bundle`'s `--environment <name>` bridge: a human names an Environment, produceBundle wants (optionally) the Deployment record for THIS workflow(+version) in that environment. Throws only when the named environment itself doesn't exist — a real environment with no deployment yet for this workflow/version is a legitimate "bare closure bundle" request (matches produceBundle's own documented optionality), not an error. */
async function resolveDeployment(store: AartStore, workflowId: string, workflowVersion: string, environmentName: string | undefined): Promise<Deployment | undefined> {
  if (!environmentName) return undefined;
  const environment = await store.environments.getByName(environmentName);
  if (!environment) {
    throw new Error(`aart bundle: environment "${environmentName}" not found. Register it first, e.g. "aart deploy ${workflowId} --target ${environmentName}".`);
  }
  const deployments = await store.deployments.list({ environmentId: environment.id, workflowId });
  return deployments.find((d) => d.workflowVersion === workflowVersion);
}

/** `aart server --environment <name>`'s bridge (AMENDMENTS.md A45): a human names an Environment, `ServerConfig.environmentId` (config.ts) wants its id. Same "throw only when the NAME itself doesn't exist" discipline as `resolveDeployment` above, for the same reason — an operator typo in `--environment` should fail loudly at startup, not silently fall back to "every environment" (this function's caller, `startServer` below, only calls this when `config.environment` is actually given; omitting the flag entirely is the documented "all environments" default and never reaches here). */
async function resolveEnvironmentId(store: AartStore, environmentName: string): Promise<string> {
  const environment = await store.environments.getByName(environmentName);
  if (!environment) {
    throw new Error(`aart server: environment "${environmentName}" not found. Register it first, e.g. "aart deploy <workflowId> --target ${environmentName}".`);
  }
  return environment.id;
}

/**
 * `store`/`engine` mirror `createRealEngineBoundary`'s own inputs (this
 * process's shared Engine — see this file's module doc comment). `root`
 * (AMENDMENTS.md A45) is the resolved `.aart` store root
 * (`CreateAartContextOptions.root`, already resolved once by
 * `cli-context.ts` before this function is called) — needed here so the
 * real `secretResolver`'s store-adjacent `secrets.json` fallback
 * (secrets.ts) reads from the SAME root this CLI invocation's store is
 * actually rooted at, not an independently-recomputed (and potentially
 * divergent, e.g. under `--root`) default.
 */
export function createRealServerPort(store: AartStore, engine: Engine, root: string): ServerPort {
  const boundary = createRealEngineBoundary(store, engine);
  const secretResolver = createRealSecretResolver(root);

  return {
    async startServer(config): Promise<ServerHandleLike> {
      const environmentId = config.environment ? await resolveEnvironmentId(store, config.environment) : undefined;
      return startRealServer({ store, engine: boundary, port: config.port, secretResolver, environmentId });
    },

    async startWorker(options): Promise<WorkerHandleLike> {
      // installSignalHandler: false — this package's own commands/process.ts
      // owns SIGTERM/SIGINT lifecycle for a CLI-invoked worker/server process
      // (waits on the signal, then calls this handle's stop()/close() itself,
      // so it can also print a clean "stopped" result) rather than letting
      // @aart/server's own default self-installed handler race it — see
      // process.ts's workerCommand/serverCommand.
      return startRealWorker({ store, engine: boundary, workerId: options.workerId, installSignalHandler: false });
    },

    async produceBundle(params): Promise<BundleLike> {
      const deployment = await resolveDeployment(store, params.workflowId, params.workflowVersion, params.environment);
      const bundle = await produceRealBundle(store, { workflowId: params.workflowId, workflowVersion: params.workflowVersion, deployment });
      return bundleToBundleLike(bundle);
    },

    async writeBundleToDisk(bundle: BundleLike, outDir: string): Promise<void> {
      await writeBundleFilesToDisk(bundle.files, outDir);
    },

    async clearRunFlag(runId: string, clearedBy: string): Promise<ClearRunFlagResult> {
      return realClearRunFlag(store, runId, clearedBy);
    },

    async listFlaggedRuns() {
      return realListFlaggedRuns(store);
    },
  };
}
