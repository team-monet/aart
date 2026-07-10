// StubServerPort — mirrors @aart/server's real, documented exports (S2
// SEAMS.md): `startServer`/`startWorker`/`produceBundle`+
// `writeBundleToDisk`/`clearRunFlag`+`listFlaggedRuns`. Real @aart/server is
// still an S0 `export {}` stub in THIS worktree (S2 builds it in the
// concurrent, unmerged /Users/johnlee/code/aart-s2).
//
// CLI-ONLY — @aart/mcp does not import this module at all. `clearRunFlag`
// is architecture §13.3's stated, deliberate exception to the three-client
// principle (un-flagging a poison/reclaim-exhausted run is a human judgment
// call — no `aart_*` MCP tool wraps it, ever).
//
// What IS real: `clearRunFlag`/`listFlaggedRuns` operate on the real
// (frozen) `RunRecord.flag` field through the real `@aart/store` — S2's own
// documented semantics ("sets clearedBy/clearedAt on the EXISTING flag
// record rather than deleting it") are simple enough to implement
// correctly without S2's actual trigger/worker machinery.
//
// What's SIMPLIFIED (flagged): `startServer`/`startWorker` don't run a real
// HTTP API or claim loop (S2's exclusive scope, architecture §6/§4.7);
// `produceBundle` doesn't compute the real transitive closure (workflow +
// referenced blocks + packs + prompt/schema registry entries, architecture
// §0.3) — it writes a minimal, structurally-correct bundle (manifest +
// the workflow definition + an empty triggers file) sufficient to exercise
// `aart bundle`'s CLI wiring end to end.
import type { AartStore } from "@aart/store";
import type { BundleLike, ClearRunFlagResult, ServerHandleLike, ServerPort, WorkerHandleLike } from "@aart/mcp";
import { writeBundleFilesToDisk } from "../bundle-files.js";

export function createStubServerPort(store: AartStore): ServerPort {
  return {
    async startServer(config): Promise<ServerHandleLike> {
      const port = config.port ?? 8080;
      return { port, async close() {} };
    },

    async startWorker(_options): Promise<WorkerHandleLike> {
      return { async stop() {} };
    },

    async produceBundle(params): Promise<BundleLike> {
      const workflow = await store.workflows.get(params.workflowId, params.workflowVersion);
      if (!workflow) throw new Error(`produceBundle: workflow ${params.workflowId}@${params.workflowVersion} not found`);
      const manifest = {
        workflowId: params.workflowId,
        workflowVersion: params.workflowVersion,
        environment: params.environment,
        createdAt: new Date().toISOString(),
      };
      const files: Record<string, string> = {
        "manifest.json": JSON.stringify(manifest, null, 2),
        "definitions/workflow.json": JSON.stringify(workflow, null, 2),
        "triggers.json": JSON.stringify({}, null, 2),
      };
      return { manifest, files };
    },

    async writeBundleToDisk(bundle: BundleLike, outDir: string): Promise<void> {
      await writeBundleFilesToDisk(bundle.files, outDir);
    },

    async clearRunFlag(runId: string, clearedBy: string): Promise<ClearRunFlagResult> {
      const run = await store.runs.get(runId);
      if (!run) return { kind: "not_found" };
      if (!run.flag) return { kind: "no_flag" };
      const updated = { ...run, flag: { ...run.flag, clearedBy, clearedAt: new Date().toISOString() } };
      await store.runs.put(updated);
      return { kind: "cleared", run: updated };
    },

    async listFlaggedRuns() {
      const all = await store.runs.list();
      return all.filter((r) => r.flag != null);
    },
  };
}
