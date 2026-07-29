#!/usr/bin/env node
// The sqlite concurrent-startup migration race E2E test's WORKER PROCESS
// (AMENDMENTS.md A58). Same "must run as a genuinely separate OS process"
// rationale as this repo's other src/e2e/*-worker.mjs scripts (e.g.
// packages/server/src/e2e/worker-kill-worker.mjs) — this specific race is
// about TWO SEPARATE `DatabaseSync` connections genuinely contending for
// the same file's write lock at once. A single Node process (even one
// juggling two in-process `DatabaseSync` handles via Promise.all) cannot
// reproduce this faithfully: `node:sqlite`'s DatabaseSync API is fully
// synchronous, so a busy_timeout retry-wait on connection B (a real,
// blocking, single-threaded C call) stalls the ENTIRE process — including
// whatever pending continuation on connection A is waiting for the event
// loop to free up to reach ITS OWN commit — which starves A instead of
// letting it run concurrently with B's wait, and B then reliably times out
// and throws regardless of whether the fix under test is correct (verified
// directly against this exact script's own logic during this fix's
// development, using node:worker_threads and a bare Promise.all — both
// genuinely deadlock/starve in-process; only real OS-level thread/process
// parallelism lets the two connections make progress concurrently the way
// two real `aart server`/`aart worker` processes would). Importing from
// this package's own compiled dist (../../dist/adapters/sqlite/index.js,
// via the SAME "./sqlite" subpath consumers outside this workspace use —
// see package.json's own "exports" map) rather than raw TS source, matching
// every other src/e2e/*-worker.mjs script's own established convention in
// this repo (plain node, no ts-node/tsx step) — the root gate sequence
// always runs `pnpm run build` before `pnpm test`, so dist is fresh by the
// time this ever runs for real.
import { openSqliteStore } from "../../dist/adapters/sqlite/index.js";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

function emit(event) {
  // One JSON line on stdout, same convention as this repo's other
  // src/e2e/*-worker.mjs scripts — the test harness parses this to learn
  // the outcome without depending on process exit codes alone (which don't
  // carry a structured error message).
  process.stdout.write(JSON.stringify(event) + "\n");
}

const args = parseArgs(process.argv);
const label = args.label ?? "worker";

async function main() {
  const path = args.path;
  if (!path) throw new Error("--path=<sqlite db path> is required");

  const handle = await openSqliteStore(path);
  try {
    const watermarkRow = handle.db.prepare("SELECT version FROM _migration_watermark WHERE id = 1").get();
    const columns = handle.db.prepare("PRAGMA table_info(deployments)").all();
    const hasPromotedColumn = columns.some((c) => c.name === "promoted");
    // D2a security hardening (AMENDMENTS.md A59) — 0003_approval_task_authenticated_as
    // is a THIRD migration subject to this exact concurrent-startup race;
    // checked the same way as hasPromotedColumn above, proving the general
    // coordination mechanism (runMigrationsCoordinated) handles a third
    // migration correctly, not just the one it was originally built for.
    const approvalTaskColumns = handle.db.prepare("PRAGMA table_info(approval_tasks)").all();
    const hasAuthenticatedAsColumn = approvalTaskColumns.some((c) => c.name === "authenticated_as");
    // V1 event log foundation (AMENDMENTS.md A61) — 0004_events_table is a
    // FOURTH migration subject to this exact race, and the first that adds
    // a whole TABLE rather than a column — `PRAGMA table_info` on a table
    // that doesn't exist returns an EMPTY array (not an error) in sqlite,
    // so a non-empty result here is a genuine, meaningful existence check,
    // not just "the query didn't throw."
    const eventsColumns = handle.db.prepare("PRAGMA table_info(events)").all();
    const hasEventsTable = eventsColumns.length > 0;
    const idempotencyColumns = handle.db.prepare("PRAGMA table_info(idempotency_ledger)").all();
    const hasIdempotencySchemaVersionColumn = idempotencyColumns.some((c) => c.name === "schema_version");
    const runColumns = handle.db.prepare("PRAGMA table_info(runs)").all();
    const hasRunRootTaintColumns = [
      "secret_tainted_input_paths_json",
      "secret_tainted_trigger_paths_json",
    ].every((name) => runColumns.some((c) => c.name === name));
    // A cheap real write through the fully-migrated schema — not just a
    // watermark-number check, but proof the schema this process's own
    // connection sees is genuinely usable end to end (the same store
    // surface `aart server`/`aart worker` actually call at startup).
    await handle.store.workflows.put({
      id: `race-check-${label}`,
      name: "race check",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });
    // A cheap real write through the events table too — same "not just a
    // schema-shape check" discipline the workflows.put call above already
    // established.
    await handle.store.events.append({ id: `race-check-event-${label}`, type: "run.started", occurredAt: new Date().toISOString(), summary: "race check" });
    emit({ label, ok: true, watermark: watermarkRow?.version, hasPromotedColumn, hasAuthenticatedAsColumn, hasEventsTable, hasIdempotencySchemaVersionColumn, hasRunRootTaintColumns });
  } finally {
    handle.close();
  }
}

main().catch((err) => {
  emit({ label, ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
