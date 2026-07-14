// Rolling-upgrade / schema-version E2E (S9 plan §4's unattempted item, S10
// completion): "persist a run+wait, bump the engine schema-version
// constant in a spawned 'newer engine' process, assert loud
// SchemaVersionMismatchError refusal on the incompatible path and
// successful resume on the compatible path."
//
// Two genuinely separate OS processes throughout (schema-version-runner.mjs,
// this same directory) — same discipline as review-cycle.e2e.test.ts and
// worker-kill.e2e.test.ts: a real rolling-upgrade proof needs a process
// boundary between "the engine build that wrote this record" and "the
// engine build trying to resume it," not two engine instances sharing one
// process's memory.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFsStore } from "@aart/store";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = join(__dirname, "schema-version-runner.mjs");

interface RunnerEvent {
  event: string;
  [key: string]: unknown;
}

function runScript(args: string[]): Promise<RunnerEvent> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("exit", () => {
      const line = stdout.trim().split("\n")[0];
      if (!line) return reject(new Error(`schema-version-runner.mjs produced no output. stderr: ${stderr}`));
      try {
        resolve(JSON.parse(line) as RunnerEvent);
      } catch (err) {
        reject(new Error(`Failed to parse runner output as JSON: ${line}. stderr: ${stderr}. ${String(err)}`));
      }
    });
    child.on("error", reject);
  });
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("rolling-upgrade / schema-version E2E — real process boundary, real hardcoded resume-time check (architecture §4.7)", () => {
  it(
    "COMPATIBLE path: a run+wait persisted by the real (default schemaVersion) engine resumes successfully in a completely fresh process running the same real engine",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aart-e2e-schema-version-compat-"));
      roots.push(root);

      // Process A: the real, unmodified engine (no --schemaVersion override) triggers a run to its wait.manual checkpoint.
      const triggered = await runScript(["--mode=trigger-and-wait", `--root=${root}`, "--workflowId=schema-compat"]);
      expect(triggered).toMatchObject({ event: "triggered", status: "waiting", schemaVersion: 1 });
      const runId = triggered["runId"] as string;

      // Confirm what's actually on disk before resuming — both RunRecord and the WaitCondition carry schemaVersion 1.
      const store = createFsStore(root);
      const persisted = await store.runs.get(runId);
      expect(persisted?.schemaVersion).toBe(1);
      const wait = await store.waits.get(runId, "pause");
      expect(wait?.schemaVersion).toBe(1);

      // Process B: a COMPLETELY FRESH process, also the real unmodified engine — resumes successfully.
      const resumed = await runScript(["--mode=resume", `--root=${root}`, `--runId=${runId}`, "--stepId=pause"]);
      expect(resumed).toMatchObject({ event: "resumed", kind: "resumed", status: "completed" });

      const finalRun = await store.runs.get(runId);
      expect(finalRun?.status).toBe("completed");
      expect(finalRun!.trace.map((t) => t.stepId)).toEqual(["before", "pause", "after"]);
    },
    20_000,
  );

  it(
    "INCOMPATIBLE path: a run+wait persisted by a --schemaVersion=2 process (modeling a newer engine build's bumped constant) is loudly refused, not silently misinterpreted, by a fresh process running the real (schemaVersion 1) engine",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "aart-e2e-schema-version-incompat-"));
      roots.push(root);

      // Process C: runs the "before" step and reaches the "pause" wait
      // checkpoint through 100% REAL engine execution (schemaVersion
      // omitted — the resume-time check is hardcoded against the literal
      // constant, so a differently-configured engine can't even complete
      // its own trigger sequence, see schema-version-runner.mjs's header
      // comment for the full reasoning) — then --schemaVersion=2 re-tags
      // ONLY the schemaVersion field on that real, already-correct
      // checkpoint, modeling what a real v2 build's own bumped constant
      // would have stamped on an otherwise-identical run.
      const triggered = await runScript(["--mode=trigger-and-wait", `--root=${root}`, "--workflowId=schema-incompat", "--schemaVersion=2"]);
      expect(triggered).toMatchObject({ event: "triggered", status: "waiting", schemaVersion: 2 });
      const runId = triggered["runId"] as string;

      const store = createFsStore(root);
      expect((await store.runs.get(runId))?.schemaVersion).toBe(2);
      expect((await store.waits.get(runId, "pause"))?.schemaVersion).toBe(2);

      // Process D: a completely fresh process running the REAL, unmodified
      // engine (no --schemaVersion override — its hardcoded resume-time
      // check always compares against the actual CURRENT_ENGINE_SCHEMA_
      // VERSION constant, 1) attempts to resume a run tagged 2.
      const resumeAttempt = await runScript(["--mode=resume", `--root=${root}`, `--runId=${runId}`, "--stepId=pause"]);
      expect(resumeAttempt).toMatchObject({ event: "resume-error", isSchemaVersionMismatchError: true });
      expect(resumeAttempt["message"]).toContain("schemaVersion 2");
      expect(resumeAttempt["message"]).toContain("does not recognize as compatible");
      expect(resumeAttempt["message"]).toContain("refusing to resume");
      expect(resumeAttempt["detail"]).toMatchObject({ kind: "schemaVersionMismatch", recordVersion: 2, engineVersion: 1 });

      // The critical safety property: the run was NOT silently mutated,
      // half-resumed, or corrupted by the refused attempt — it's exactly
      // as Process C left it, still genuinely waiting, still tagged 2, its
      // wait checkpoint intact for a REAL version-2-compatible engine to
      // resume correctly later.
      const stillWaiting = await store.runs.get(runId);
      expect(stillWaiting?.status).toBe("waiting");
      expect(stillWaiting?.schemaVersion).toBe(2);
      // "pause" itself has its own trace entry (status: "waiting", recorded
      // when the wait was entered) alongside "before" — the refused resume
      // attempt added nothing further and removed nothing.
      expect(stillWaiting!.trace.map((t) => t.stepId)).toEqual(["before", "pause"]);
      expect(stillWaiting!.trace.find((t) => t.stepId === "pause")?.status).toBe("waiting");
      const waitStillThere = await store.waits.get(runId, "pause");
      expect(waitStillThere?.schemaVersion).toBe(2);
    },
    20_000,
  );
});
