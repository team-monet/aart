#!/usr/bin/env node
// The rolling-upgrade / schema-version E2E test's runner process (S9 plan
// §4's unattempted item, S10 completion). Same "must run as a genuinely
// separate OS process" discipline as redacted-legacy-b-worker.mjs/worker-kill
// -worker.mjs — a real rolling upgrade means two DIFFERENT engine builds,
// running as genuinely separate processes, one reading state the other
// wrote; simulating that in-process (two engine instances in one Node
// process) would prove nothing about a real deployment's actual failure
// mode.
//
// schema-version.ts's resume-time check (assertSchemaVersionCompatible,
// called from wait-machine.ts/run-lifecycle.ts) is HARDCODED against the
// literal CURRENT_ENGINE_SCHEMA_VERSION constant — it does NOT accept a
// per-call override. This is deliberate (architecture's intent: "this
// engine BUILD's own compatible-version range" is a property of the code
// that's running, not something a caller should be able to spoof at
// resume time) but it has a real consequence for simulating "a newer
// engine build" without actually forking/recompiling the package: setting
// EngineConfig.schemaVersion to anything other than the real constant
// breaks that SAME process's own subsequent executeRun/resume calls too
// (verified directly — an earlier version of this script tried exactly
// that and failed immediately, `resume-time check reads the literal
// constant, ignores config.schemaVersion, so a "v2-configured" engine
// immediately rejects the v2-tagged record IT ITSELF just wrote). A real
// recompiled v2 build wouldn't have this problem (both its write-time tag
// and its read-time check derive from the SAME bumped literal constant,
// consistently) — but faithfully reproducing that here would mean
// temporarily mutating this repo's own source and rebuilding mid-test,
// which is fragile and not worth the risk for what amounts to the same
// proof.
//
// What this script does instead, honestly: uses the REAL, unmodified
// engine (schemaVersion omitted -> the real constant, 1) to run the
// "before" step and reach the "pause" wait checkpoint through 100% real
// execution — then, ONLY if --schemaVersion=N differs from the real
// constant, directly re-tags the JUST-PERSISTED RunRecord/WaitCondition's
// own schemaVersion field to N via the store (everything else about the
// checkpoint — the trace, the wait's own type/shape — is exactly what the
// real engine produced; only the version tag itself is adjusted, modeling
// what a real v-N build's own bumped constant would have stamped on an
// otherwise-identical checkpoint). This is what "trigger-and-wait" below
// actually does; --mode=resume is always the real, unmodified engine.
import { createFsStore } from "@aart/store";
import { createEngine, identityRedactFn, alwaysAllowCapabilityCheck, SchemaVersionMismatchError } from "@aart/engine";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const echoBlock = {
  manifest: { id: "test.echo", version: "1.0.0", capabilities: [], inputSchema: {}, outputSchema: {}, description: "echoes input" },
  execute: async (input) => ({ echoed: input }),
};

function fixtureWorkflow(id) {
  return {
    id,
    name: "Schema-version fixture workflow",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: {
      type: "workflow",
      steps: [
        { id: "before", uses: "test.echo", with: { phase: "before-wait" }, next: "pause" },
        { id: "pause", uses: "wait.manual", with: {}, next: "after" },
        { id: "after", uses: "test.echo", with: { phase: "after-wait" } },
      ],
    },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root;
  if (!root) throw new Error("--root=<store path> is required");

  const store = createFsStore(root);
  // ALWAYS the real, unmodified engine — schemaVersion is never passed to
  // createEngine (see this file's own header comment for why: doing so
  // would break this SAME process's own executeRun call below, before it
  // could ever reach the wait checkpoint).
  const engine = createEngine({ store, redact: identityRedactFn, capabilityCheck: alwaysAllowCapabilityCheck, blocks: { [echoBlock.manifest.id]: echoBlock } });

  if (args.mode === "trigger-and-wait") {
    const workflowId = args.workflowId ?? "schema-version-fixture";
    const workflow = fixtureWorkflow(workflowId);
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({
      workflow,
      trigger: { id: "e2e-trigger", type: "manual", source: "schema-version.e2e.test", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
    });
    const finished = await engine.executeRun(run.runId);

    const targetVersion = args.schemaVersion !== undefined ? Number(args.schemaVersion) : finished.schemaVersion;
    if (targetVersion !== finished.schemaVersion) {
      // Re-tag ONLY the schemaVersion field on the just-persisted,
      // real-engine-produced RunRecord and WaitCondition — see this
      // file's header comment for exactly why this is the honest way to
      // model "a real v-N build's own bumped constant" without
      // temporarily mutating this repo's actual source mid-test.
      const run2 = await store.runs.get(finished.runId);
      await store.runs.put({ ...run2, schemaVersion: targetVersion });
      const wait2 = await store.waits.get(finished.runId, "pause");
      await store.waits.put(finished.runId, "pause", { ...wait2, schemaVersion: targetVersion }, new Date().toISOString());
    }

    const reread = await store.runs.get(finished.runId);
    emit({ event: "triggered", runId: finished.runId, status: reread.status, schemaVersion: reread.schemaVersion });
    return;
  }

  if (args.mode === "resume") {
    const runId = args.runId;
    const stepId = args.stepId ?? "pause";
    try {
      const outcome = await engine.resumeManual(runId, stepId, {});
      emit({ event: "resumed", kind: outcome.kind, status: outcome.kind === "resumed" ? outcome.run.status : undefined });
    } catch (err) {
      emit({
        event: "resume-error",
        errorClass: err instanceof Error ? (err).errorClass ?? err.name : undefined,
        isSchemaVersionMismatchError: err instanceof SchemaVersionMismatchError,
        message: err instanceof Error ? err.message : String(err),
        detail: err && typeof err === "object" && "detail" in err ? err.detail : undefined,
      });
    }
    return;
  }

  throw new Error(`Unknown --mode="${args.mode}" (expected "trigger-and-wait" or "resume")`);
}

main().catch((err) => {
  emit({ event: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exitCode = 1;
});
