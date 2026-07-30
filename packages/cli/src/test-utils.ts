// Shared test helpers — NOT itself a test file.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@aart/types";
import { createCliContext, type CliContext } from "./cli-context.js";

export interface TestCli {
  cli: CliContext;
  root: string;
  cwd: string;
  cleanup: () => Promise<void>;
}

export async function createTestCli(): Promise<TestCli> {
  const base = await fs.mkdtemp(join(tmpdir(), "aart-cli-"));
  const root = join(base, ".aart");
  const cwd = join(base, "project");
  await fs.mkdir(cwd, { recursive: true });
  // real: false — this package's own unit-test suite is built against the
  // fast, deterministic, offline stub engine (no real browser/LLM dispatch)
  // — see cli-context.ts's module doc comment. Everything else (real CLI
  // use, bin.ts) gets the real composition by default.
  const cli = createCliContext({ root, trustMode: "governed", real: false });
  return { cli, root, cwd, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

export async function putCorrectableRun(
  testCli: TestCli,
  runId: string,
  stepId: string,
): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const run: RunRecord = {
    runId,
    workflowId: "correction-fixture",
    workflowVersion: "0.1.0",
    status: "completed",
    approved: true,
    approvalMode: "dev",
    trigger: {
      type: "manual",
      id: `trigger-${runId}`,
      source: "test",
      payload: {},
      receivedAt: now,
    },
    inputs: {},
    trace: [
      {
        seq: 0,
        stepId,
        block: "test.block",
        status: "completed",
        inputs: {},
        outputs: {},
        startedAt: now,
      },
    ],
    waits: [],
    artifacts: [],
    snapshot: {
      definitions: {},
      resolvedVersions: {},
      packHashes: {},
      capturedAt: now,
    },
    startedAt: now,
    updatedAt: now,
    endedAt: now,
    schemaVersion: 1,
  };
  await testCli.cli.aart.store.runs.put(run);
}

export function sampleWorkflowYaml(id: string, version = "0.1.0"): string {
  return `id: ${id}
name: Sample Workflow
version: ${version}
inputs:
  url:
    type: string
    required: true
steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"
  - id: read
    uses: web.read
`;
}

export function approvalWaitWorkflowYaml(id: string, version = "0.1.0"): string {
  return `id: ${id}
name: Approval Wait Workflow
version: ${version}
steps:
  - id: approve
    uses: human.approval
    with:
      title: "Approve me"
      description: "Needs a human decision."
`;
}
