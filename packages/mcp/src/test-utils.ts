// Shared test helpers — NOT itself a test file (no `*.test.ts` suffix, so
// vitest's `include` glob skips it). Isolated-tmp-dir-per-test pattern
// matches @aart/store's own fs-store.test.ts convention.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "@aart/types";
import { createAartContext, type AartContext, type CreateAartContextOptions } from "./context.js";

export async function makeTempRoot(prefix = "aart-mcp-"): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupTempRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

export interface TestContext {
  ctx: AartContext;
  root: string;
  cleanup: () => Promise<void>;
}

export async function createTestContext(options: Omit<CreateAartContextOptions, "root"> = {}): Promise<TestContext> {
  const root = await makeTempRoot();
  const ctx = createAartContext({ ...options, root });
  return { ctx, root, cleanup: () => cleanupTempRoot(root) };
}

export async function putCorrectableRun(
  ctx: AartContext,
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
  await ctx.store.runs.put(run);
}

/** A small, valid sugar-form workflow YAML fixture reused across handler tests — a 2-step workflow with no wait/fail blocks, so it always runs straight through to "completed" under StubEngine. */
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

/** A workflow that ends in a `human.approval` wait — used to test list/resume/approve flows. */
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

/** A workflow that always fails via flow.fail — used to test failure paths. */
export function failingWorkflowYaml(id: string, version = "0.1.0"): string {
  return `id: ${id}
name: Failing Workflow
version: ${version}
steps:
  - id: boom
    uses: flow.fail
    with:
      message: "intentional"
`;
}
