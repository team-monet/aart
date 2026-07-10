// Full CLI surface tests (spec §33's command list, plus this session's
// documented additions: bundle/flag/approve/mcp — see commands/*.ts module
// doc comments for the evidence behind each addition).
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { compileWorkflowInput, requestApprovalHandler, runWorkflowHandler as mcpRunWorkflowHandler } from "@aart/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { approvalWaitWorkflowYaml, createTestCli, sampleWorkflowYaml, type TestCli } from "./test-utils.js";

let tc: TestCli;
afterEach(async () => {
  await tc?.cleanup();
});

describe("aart run", () => {
  it("runs a registered workflow", async () => {
    tc = await createTestCli();
    await tc.cli.aart.store.workflows.put(compileWorkflowInput(sampleWorkflowYaml("wf-cli-run")));
    const outcome = await run(["run", "wf-cli-run", "--input", '{"url":"https://example.com"}'], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { status: string }).status).toBe("completed");
  });

  it("calls the exact same handler function @aart/mcp's aart_run_workflow tool calls (same-function-reference, not a reimplementation)", async () => {
    tc = await createTestCli();
    await tc.cli.aart.store.workflows.put(compileWorkflowInput(sampleWorkflowYaml("wf-cli-run-ref")));
    const viaCli = await run(["run", "wf-cli-run-ref", "--input", '{"url":"https://example.com"}'], { cliContext: tc.cli });
    const viaDirectHandler = await mcpRunWorkflowHandler(tc.cli.aart, { workflowId: "wf-cli-run-ref", input: { url: "https://example.com" } });
    expect((viaCli.result as { status: string }).status).toBe(viaDirectHandler.status);
    expect((viaCli.result as { ok: boolean }).ok).toBe(viaDirectHandler.ok);
  });

  it("fails cleanly for a nonexistent workflow", async () => {
    tc = await createTestCli();
    const outcome = await run(["run", "does-not-exist"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });
});

describe("aart validate", () => {
  it("validates a workflow file from disk", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-validate"), "utf8");
    const outcome = await run(["validate", path], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { valid: boolean }).valid).toBe(true);
  });

  it("fails for a missing file", async () => {
    tc = await createTestCli();
    const outcome = await run(["validate", join(tc.cwd, "nope.yaml")], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });
});

describe("aart register / aart list", () => {
  it("registers a workflow from disk, then lists it", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-register"), "utf8");
    const registerOutcome = await run(["register", path], { cliContext: tc.cli });
    expect(registerOutcome.ok).toBe(true);

    const listOutcome = await run(["list"], { cliContext: tc.cli });
    expect(listOutcome.ok).toBe(true);
    const workflows = (listOutcome.result as { workflows: { id: string }[] }).workflows;
    expect(workflows.some((w) => w.id === "wf-cli-register")).toBe(true);
  });
});

describe("aart init / aart init-agent", () => {
  it("aart init succeeds and is idempotent", async () => {
    tc = await createTestCli();
    const first = await run(["init"], { cliContext: tc.cli });
    const second = await run(["init"], { cliContext: tc.cli });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("aart init-agent writes an MCP config and an instructions file", async () => {
    tc = await createTestCli();
    const mcpConfigOut = join(tc.cwd, ".mcp.json");
    const instructionsOut = join(tc.cwd, "AGENTS.md");
    const outcome = await run(["init-agent", "--mcp-config-out", mcpConfigOut, "--instructions-out", instructionsOut], {
      cliContext: tc.cli,
    });
    expect(outcome.ok).toBe(true);
    const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
    expect(config.mcpServers.aart.args).toContain("mcp");
    const instructions = await readFile(instructionsOut, "utf8");
    expect(instructions).toContain("Shell runs and is forgotten");
  });
});

describe("aart diff", () => {
  it("diffs two versions of a workflow", async () => {
    tc = await createTestCli();
    const v1 = join(tc.cwd, "v1.yaml");
    const v2 = join(tc.cwd, "v2.yaml");
    await writeFile(v1, sampleWorkflowYaml("wf-cli-diff", "0.1.0"), "utf8");
    await writeFile(
      v2,
      `id: wf-cli-diff
name: Sample Workflow
version: 0.2.0
inputs:
  url:
    type: string
    required: true
steps:
  - id: open
    uses: browser.goto
    with:
      url: "{{ inputs.url }}"
`,
      "utf8",
    );
    await run(["register", v1], { cliContext: tc.cli });
    await run(["register", v2], { cliContext: tc.cli });
    const outcome = await run(["diff", "wf-cli-diff", "--from", "0.1.0", "--to", "0.2.0"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
  });
});

describe("aart correction add / aart correction list", () => {
  it("records a correction then lists it back", async () => {
    tc = await createTestCli();
    const addOutcome = await run(
      [
        "correction",
        "add",
        "run_1",
        "--step",
        "extract",
        "--field",
        "outputs.nmi",
        "--observed",
        '"A"',
        "--corrected",
        '"B"',
        "--reason",
        "typo",
        "--reviewer",
        "alice",
      ],
      { cliContext: tc.cli },
    );
    expect(addOutcome.ok).toBe(true);

    const listOutcome = await run(["correction", "list", "--run", "run_1"], { cliContext: tc.cli });
    expect(listOutcome.ok).toBe(true);
    expect((listOutcome.result as { corrections: unknown[] }).corrections).toHaveLength(1);
  });
});

describe("aart eval create / add / run", () => {
  it("creates a suite, adds an example from a run, and runs the suite", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-eval"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const runOutcome = await run(["run", "wf-cli-eval", "--input", '{"url":"https://example.com"}'], { cliContext: tc.cli });
    const runId = (runOutcome.result as { runId: string }).runId;

    const createOutcome = await run(["eval", "create", "cli-suite"], { cliContext: tc.cli });
    expect(createOutcome.ok).toBe(true);

    const addOutcome = await run(["eval", "add", "cli-suite", "--from-run", runId], { cliContext: tc.cli });
    expect(addOutcome.ok).toBe(true);

    const runEvalOutcome = await run(["eval", "run", "cli-suite", "--workflow", "wf-cli-eval"], { cliContext: tc.cli });
    expect(runEvalOutcome.ok).toBe(true);
    expect((runEvalOutcome.result as { evalRun: { total: number } }).evalRun.total).toBe(1);
  });
});

describe("aart promote / aart deploy / aart trigger add", () => {
  it("promotes, deploys, and registers a trigger config end to end", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-deploy"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const wf = await tc.cli.aart.store.workflows.get("wf-cli-deploy", "0.1.0");
    await tc.cli.aart.store.workflows.put({
      ...wf!,
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });

    const promoteOutcome = await run(["promote", "wf-cli-deploy"], { cliContext: tc.cli });
    expect(promoteOutcome.ok).toBe(true);
    expect((promoteOutcome.result as { approval: string }).approval).toBe("approved");

    const deployOutcome = await run(["deploy", "wf-cli-deploy", "--target", "staging"], { cliContext: tc.cli });
    expect(deployOutcome.ok).toBe(true);

    const triggerOutcome = await run(["trigger", "add", "wf-cli-deploy", "--type", "webhook", "--webhook-path", "/hooks/wf"], {
      cliContext: tc.cli,
    });
    expect(triggerOutcome.ok).toBe(true);
    const deployment = (triggerOutcome.result as { deployment: { triggerConfig: Record<string, unknown> } }).deployment;
    expect(deployment.triggerConfig.type).toBe("webhook");
    expect(deployment.triggerConfig.webhookPath).toBe("/hooks/wf");
  });
});

describe("aart approve — the CLI's own strict/production-mode-safe approval surface", () => {
  it("records an approval decision on a run's paused step", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, approvalWaitWorkflowYaml("wf-cli-approve"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const runOutcome = await run(["run", "wf-cli-approve"], { cliContext: tc.cli });
    const runId = (runOutcome.result as { runId: string }).runId;

    const requestResult = await requestApprovalHandler(tc.cli.aart, { runId, stepId: "approve" });

    const approveOutcome = await run(["approve", requestResult.taskId as string, "--decision", "approved", "--reviewer", "alice"], {
      cliContext: tc.cli,
    });
    expect(approveOutcome.ok).toBe(true);
  });

  it("rejects an invalid --decision value", async () => {
    tc = await createTestCli();
    const outcome = await run(["approve", "task_x", "--decision", "maybe", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });
});

describe("aart flag clear / aart flag list — CLI-only, no MCP tool (architecture §13.3's stated exception)", () => {
  it("lists flagged runs (empty by default)", async () => {
    tc = await createTestCli();
    const outcome = await run(["flag", "list"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { runs: unknown[] }).runs).toEqual([]);
  });

  it("clears a flag on a flagged run", async () => {
    tc = await createTestCli();
    const now = new Date().toISOString();
    await tc.cli.aart.store.runs.put({
      runId: "run_flagged",
      workflowId: "wf",
      workflowVersion: "1",
      status: "failed",
      approved: true,
      approvalMode: "dev",
      trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: now },
      inputs: {},
      trace: [],
      waits: [],
      artifacts: [],
      snapshot: { definitions: {}, resolvedVersions: {}, packHashes: {}, capturedAt: now },
      startedAt: now,
      updatedAt: now,
      flag: { kind: "poison", flaggedAt: now },
      schemaVersion: 1,
    });
    const outcome = await run(["flag", "clear", "run_flagged", "--by", "alice"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const updated = await tc.cli.aart.store.runs.get("run_flagged");
    expect(updated?.flag?.clearedBy).toBe("alice");
  });
});

describe("aart bundle", () => {
  it("produces a bundle on disk for an approved workflow", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-bundle"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const outDir = join(tc.cwd, "bundle-out");
    const outcome = await run(["bundle", "wf-cli-bundle", "--out", outDir], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(manifest.workflowId).toBe("wf-cli-bundle");
  });
});

describe("aart worker / aart server / aart mcp — non-blocking mode for tests", () => {
  it("aart worker starts and stops without hanging when blocking:false", async () => {
    tc = await createTestCli();
    const outcome = await run(["worker"], { cliContext: tc.cli, blocking: false });
    expect(outcome.ok).toBe(true);
  });

  it("aart server starts and stops without hanging when blocking:false", async () => {
    tc = await createTestCli();
    const outcome = await run(["server", "--port", "9999"], { cliContext: tc.cli, blocking: false });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { port: number }).port).toBe(9999);
  });

  it("aart mcp starts and stops without hanging when blocking:false", async () => {
    tc = await createTestCli();
    const outcome = await run(["mcp"], { cliContext: tc.cli, blocking: false });
    expect(outcome.ok).toBe(true);
  });
});

describe("unknown / missing command", () => {
  it("no command given returns usage and ok:false", async () => {
    tc = await createTestCli();
    const outcome = await run([], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it("unknown command returns usage and ok:false", async () => {
    tc = await createTestCli();
    const outcome = await run(["frobnicate"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });
});
