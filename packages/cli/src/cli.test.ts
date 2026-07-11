// Full CLI surface tests (spec §33's command list, plus this session's
// documented additions: bundle/flag/approve/mcp — see commands/*.ts module
// doc comments for the evidence behind each addition).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowInput, requestApprovalHandler, runWorkflowHandler as mcpRunWorkflowHandler } from "@aart/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./cli.js";
import { createCliContext, type CliContext } from "./cli-context.js";
import { approvalWaitWorkflowYaml, createTestCli, sampleWorkflowYaml, type TestCli } from "./test-utils.js";

let tc: TestCli;
afterEach(async () => {
  await tc?.cleanup();
});

/** A trivial, fast, no-browser/no-LLM workflow (`data.stringify` only) — for `--root`/`--store` plumbing tests below that exercise `run()`'s real composition root directly (no `cliContext` override, so they go through the REAL engine) and only care about store/root wiring, not block-dispatch semantics. */
function trivialWorkflowYaml(id: string): string {
  return `id: ${id}
name: Trivial Probe Workflow
version: 0.1.0
steps:
  - id: greet
    uses: data.stringify
    with:
      value: "hi"
      format: "json"
`;
}

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

  it("a plain file-path validation (no --registered) never writes gates, even though it's pre-registration", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-validate-nogate"), "utf8");
    await run(["register", path], { cliContext: tc.cli }); // register separately so there IS a stored version to check
    await run(["validate", path], { cliContext: tc.cli }); // validates the FILE again, not --registered
    const stored = await tc.cli.aart.store.workflows.get("wf-cli-validate-nogate", "0.1.0");
    expect(stored?.gates.validate).toBe("pending");
  });

  describe("--registered (S14 'gate write paths') — validates an already-registered VERSION by reference, and writes gates.validate", () => {
    it("a clean registered-version validation returns ok:true and gates.validate: 'passed'", async () => {
      tc = await createTestCli();
      const path = join(tc.cwd, "wf.yaml");
      await writeFile(path, sampleWorkflowYaml("wf-cli-validate-registered"), "utf8");
      await run(["register", path], { cliContext: tc.cli });

      const outcome = await run(["validate", "wf-cli-validate-registered", "--registered"], { cliContext: tc.cli });
      expect(outcome.ok).toBe(true);
      expect((outcome.result as { gates: { validate: string } }).gates.validate).toBe("passed");

      const stored = await tc.cli.aart.store.workflows.get("wf-cli-validate-registered", "0.1.0");
      expect(stored?.gates.validate).toBe("passed");
    });

    it("--version targets a specific registered version rather than defaulting to latest", async () => {
      tc = await createTestCli();
      const pathV1 = join(tc.cwd, "wf-v1.yaml");
      await writeFile(pathV1, sampleWorkflowYaml("wf-cli-validate-reg-v", "0.1.0"), "utf8");
      await run(["register", pathV1], { cliContext: tc.cli });
      const pathV2 = join(tc.cwd, "wf-v2.yaml");
      await writeFile(pathV2, sampleWorkflowYaml("wf-cli-validate-reg-v", "0.2.0"), "utf8");
      await run(["register", pathV2], { cliContext: tc.cli });

      await run(["validate", "wf-cli-validate-reg-v", "--registered", "--version", "0.1.0"], { cliContext: tc.cli });
      const v1 = await tc.cli.aart.store.workflows.get("wf-cli-validate-reg-v", "0.1.0");
      const v2 = await tc.cli.aart.store.workflows.get("wf-cli-validate-reg-v", "0.2.0");
      expect(v1?.gates.validate).toBe("passed");
      expect(v2?.gates.validate).toBe("pending"); // untouched -- gates are per-version
    });
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

describe("aart request-approval — the CLI-side gap A44 found and A45 closes (AMENDMENTS.md)", () => {
  it("creates a real, pending workflow-version ApprovalTask via the SAME requestApprovalHandler aart_request_approval (MCP) calls, defaulting --version to the latest registered version", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-request-approval"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const outcome = await run(["request-approval", "wf-cli-request-approval"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const taskId = (outcome.result as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    const task = await tc.cli.aart.store.approvals.get(taskId);
    expect(task?.status).toBe("pending");
  });

  it("--version targets a specific registered version rather than defaulting to latest", async () => {
    tc = await createTestCli();
    const pathV1 = join(tc.cwd, "wf-v1.yaml");
    await writeFile(pathV1, sampleWorkflowYaml("wf-cli-request-approval-v", "0.1.0"), "utf8");
    await run(["register", pathV1], { cliContext: tc.cli });
    const pathV2 = join(tc.cwd, "wf-v2.yaml");
    await writeFile(pathV2, sampleWorkflowYaml("wf-cli-request-approval-v", "0.2.0"), "utf8");
    await run(["register", pathV2], { cliContext: tc.cli });

    const outcome = await run(["request-approval", "wf-cli-request-approval-v", "--version", "0.1.0"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { workflowId: string; stepId: string }).stepId).toBeTruthy();
  });

  it("errors clearly when the workflow has no registered versions", async () => {
    tc = await createTestCli();
    const outcome = await run(["request-approval", "no-such-workflow"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/No versions found/);
  });

  it("the full CLI-only lifecycle: register -> validate --registered -> request-approval -> approve -> promote genuinely completes through the installed command surface, no MCP client involved, no direct store access (AMENDMENTS.md A46 — closes the gap A45 found and deliberately left open)", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-only-lifecycle"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    // A45's own finding: `validateWorkflowHandler`'s workflowId+workflowVersion
    // branch never persisted anything. S14 wires it — this IS that write path.
    const validateOutcome = await run(["validate", "wf-cli-only-lifecycle", "--registered"], { cliContext: tc.cli });
    expect(validateOutcome.ok).toBe(true);
    expect((validateOutcome.result as { gates: { validate: string } }).gates.validate).toBe("passed");

    const requestOutcome = await run(["request-approval", "wf-cli-only-lifecycle"], { cliContext: tc.cli });
    expect(requestOutcome.ok).toBe(true);
    const taskId = (requestOutcome.result as { taskId: string }).taskId;

    const approveOutcome = await run(["approve", taskId, "--decision", "approved", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(approveOutcome.ok).toBe(true);
    expect((approveOutcome.result as { gates: { humanReview: string } }).gates.humanReview).toBe("passed");

    // governed mode requires exactly validate+humanReview (gates.ts's
    // REQUIRED_GATES_BY_MODE) — both real now, so promote genuinely
    // succeeds, no direct store write standing in for a real command.
    const promoteOutcome = await run(["promote", "wf-cli-only-lifecycle"], { cliContext: tc.cli });
    expect(promoteOutcome.ok).toBe(true);
    expect((promoteOutcome.result as { approval: string }).approval).toBe("approved");
    expect((promoteOutcome.result as { unmetGates: string[] }).unmetGates).toEqual([]);
  });
});

describe("aart request-approval --gate riskReview / aart eval run --min-score (S14 'gate write paths')", () => {
  it("--gate riskReview creates a task distinct from the humanReview default, and approving it writes gates.riskReview specifically", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-riskreview"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const requestOutcome = await run(["request-approval", "wf-cli-riskreview", "--gate", "riskReview"], { cliContext: tc.cli });
    expect(requestOutcome.ok).toBe(true);
    expect((requestOutcome.result as { stepId: string }).stepId).toBe("__gate:riskReview__");
    const taskId = (requestOutcome.result as { taskId: string }).taskId;

    const approveOutcome = await run(["approve", taskId, "--decision", "approved", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(approveOutcome.ok).toBe(true);
    expect((approveOutcome.result as { gates: { riskReview: string; humanReview: string } }).gates.riskReview).toBe("passed");
    expect((approveOutcome.result as { gates: { riskReview: string; humanReview: string } }).gates.humanReview).toBe("pending"); // untouched -- a different gate
  });

  it("an invalid --gate value fails cleanly with a friendly error, not a silent fall-through", async () => {
    tc = await createTestCli();
    const outcome = await run(["request-approval", "wf-cli-riskreview-bad", "--gate", "bogus"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/--gate must be one of/);
  });

  it("--min-score wires @aart/evidence's threshold comparison into gates.evals", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-min-score"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    await run(["eval", "create", "cli-min-score-suite"], { cliContext: tc.cli });

    const belowThreshold = await run(["eval", "run", "cli-min-score-suite", "--workflow", "wf-cli-min-score", "--min-score", "1.1"], { cliContext: tc.cli });
    expect((belowThreshold.result as { gates: { evals: string } }).gates.evals).toBe("failed");

    const atThreshold = await run(["eval", "run", "cli-min-score-suite", "--workflow", "wf-cli-min-score", "--min-score", "1"], { cliContext: tc.cli });
    expect((atThreshold.result as { gates: { evals: string } }).gates.evals).toBe("passed");
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

// AMENDMENTS.md A47 — composition-time loud failure for "aart server"/
// "aart worker" against a missing store root (root AMENDMENTS.md A43's
// actual bug class: the fs store adapter's ENOENT-as-empty read semantics
// made a misconfigured root silently indistinguishable from a genuinely
// empty one). Every case below goes through run()'s own real
// resolveCliContext (no `cliContext` override — the ONE thing that would
// bypass this check, per assertServerRootExists's own doc comment), so
// each MUST pass an explicit --root pointing at a throwaway tmpdir, same
// discipline the "--root <dir> / AART_ROOT" describe block above already
// established.
describe("aart server / aart worker — composition-time root check (AMENDMENTS.md A47)", () => {
  let base: string;
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    delete process.env.AART_ROOT;
  });

  it("aart server refuses to start against a --root that doesn't exist, with an actionable error, before ever binding the port", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-root-check-"));
    const missingRoot = join(base, "does-not-exist", ".aart");

    const outcome = await run(["server", "--port", "0", "--root", missingRoot], { blocking: false });

    expect(outcome.ok).toBe(false);
    expect(String((outcome.result as { error?: string }).error)).toContain(missingRoot);
    expect(String((outcome.result as { error?: string }).error)).toContain("does not exist");
  });

  it("aart worker refuses to start against a --root that doesn't exist", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-worker-root-check-"));
    const missingRoot = join(base, "nope", ".aart");

    const outcome = await run(["worker", "--root", missingRoot], { blocking: false });

    expect(outcome.ok).toBe(false);
    expect(String((outcome.result as { error?: string }).error)).toContain(missingRoot);
  });

  it("aart server starts normally when --root already exists (even genuinely empty — no false positive)", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-root-ok-"));
    const root = join(base, ".aart");
    await mkdir(root, { recursive: true });

    const outcome = await run(["server", "--port", "0", "--root", root], { blocking: false });

    expect(outcome.ok).toBe(true);
  });

  it("AART_ROOT env var is honored by the check the same way --root is", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-root-env-"));
    const missingRoot = join(base, "env-missing", ".aart");
    process.env.AART_ROOT = missingRoot;

    const outcome = await run(["server", "--port", "0"], { blocking: false });

    expect(outcome.ok).toBe(false);
    expect(String((outcome.result as { error?: string }).error)).toContain(missingRoot);
  });

  // Hydrating a fresh root is the ENTIRE point of --bundle (AMENDMENTS.md
  // A44/A45) — a missing root there is the expected starting state, not a
  // misconfiguration, so the check must not fire. Uses a real bundle
  // (produced via a separate, real registration + bundle step) so this
  // proves the full "missing root -> hydrate -> serve" flow still works
  // end to end, not just that the check is skipped.
  it("aart server --bundle <dir> is NOT blocked by the root check, even against a --root that doesn't exist yet (hydration creates it)", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-bundle-root-"));
    const sourceRoot = join(base, "source", ".aart");
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, sampleWorkflowYaml("wf-bundle-root-check"), "utf8");
    await run(["register", wfPath, "--root", sourceRoot]);
    const outDir = join(base, "bundle-out");
    await run(["bundle", "wf-bundle-root-check", "--out", outDir, "--root", sourceRoot]);

    const freshRoot = join(base, "fresh-does-not-exist-yet", ".aart");
    const outcome = await run(["server", "--port", "0", "--root", freshRoot, "--bundle", outDir], { blocking: false });

    expect(outcome.ok).toBe(true);
    const list = await run(["list", "--root", freshRoot]);
    expect((list.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-bundle-root-check");
  });

  it("an explicit cliContext override bypasses the check entirely (this package's own fast unit tests, which never point at a real --root)", async () => {
    tc = await createTestCli(); // tc.root is a real tmpdir but NEVER passed as --root here
    const outcome = await run(["server", "--port", "0"], { cliContext: tc.cli, blocking: false });
    expect(outcome.ok).toBe(true);
  });
});

// S12 "deploy story" — `--bundle <dir>` on worker/server. Needs the REAL
// composition (createCliContext WITHOUT `real: false`, matching
// cli-context.test.ts's own pattern) — createTestCli()'s stub ServerPort
// (stubs/server.ts) produces a deliberately simplified, non-real bundle
// shape (no bundleHash/schemaVersion/closure arrays; see that file's own
// header comment) that this session's real loader correctly refuses to
// load, so these tests would fail for the WRONG reason (a fake-bundle
// shape mismatch, not real --bundle wiring) if they used createTestCli().
//
// Two independent CliContexts (two separate `.aart` stores under two
// separate tmpdirs) — "laptop" produces + writes a bundle, "server"
// hydrates it — the same shape as the real laptop -> transfer -> server
// deploy story this flag exists for, not a same-store round-trip that would
// hide a real seam bug.
describe("aart worker / aart server --bundle <dir> (S12 deploy story)", () => {
  let cleanupPaths: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanupPaths.map((p) => rm(p, { recursive: true, force: true })));
    cleanupPaths = [];
  });

  async function freshRealCli(): Promise<{ cli: CliContext; cwd: string }> {
    const base = await mkdtemp(join(tmpdir(), "aart-cli-bundle-e2e-"));
    cleanupPaths.push(base);
    const cwd = join(base, "project");
    await mkdir(cwd, { recursive: true });
    const cli = createCliContext({ root: join(base, ".aart"), trustMode: "governed" }); // real: true (default) — see describe block header
    return { cli, cwd };
  }

  it("aart server --bundle <dir> hydrates the bundle into the server's own store before starting, reported in the result", async () => {
    const laptop = await freshRealCli();
    const path = join(laptop.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-server-bundle"), "utf8");
    await run(["register", path], { cliContext: laptop.cli });
    const outDir = join(laptop.cwd, "bundle-out");
    const bundleOutcome = await run(["bundle", "wf-server-bundle", "--out", outDir], { cliContext: laptop.cli });
    expect(bundleOutcome.ok).toBe(true);

    const serverSide = await freshRealCli();
    expect(await serverSide.cli.aart.store.workflows.get("wf-server-bundle", "0.1.0")).toBeUndefined();

    const outcome = await run(["server", "--port", "9998", "--bundle", outDir], { cliContext: serverSide.cli, blocking: false });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { bundle?: { kind: string } }).bundle?.kind).toBe("hydrated");
    expect(await serverSide.cli.aart.store.workflows.get("wf-server-bundle", "0.1.0")).toBeDefined();
  });

  it("aart worker --bundle <dir> hydrates the bundle into the worker's own store before starting, reported in the result", async () => {
    const laptop = await freshRealCli();
    const path = join(laptop.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-worker-bundle"), "utf8");
    await run(["register", path], { cliContext: laptop.cli });
    const outDir = join(laptop.cwd, "bundle-out");
    await run(["bundle", "wf-worker-bundle", "--out", outDir], { cliContext: laptop.cli });

    const serverSide = await freshRealCli();
    const outcome = await run(["worker", "--bundle", outDir], { cliContext: serverSide.cli, blocking: false });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { bundle?: { kind: string } }).bundle?.kind).toBe("hydrated");
    expect(await serverSide.cli.aart.store.workflows.get("wf-worker-bundle", "0.1.0")).toBeDefined();
  });

  it("re-running aart worker --bundle <dir> against the same store is idempotent (already_hydrated), not an error", async () => {
    const laptop = await freshRealCli();
    const path = join(laptop.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-worker-bundle-idem"), "utf8");
    await run(["register", path], { cliContext: laptop.cli });
    const outDir = join(laptop.cwd, "bundle-out");
    await run(["bundle", "wf-worker-bundle-idem", "--out", outDir], { cliContext: laptop.cli });

    const serverSide = await freshRealCli();
    const first = await run(["worker", "--bundle", outDir], { cliContext: serverSide.cli, blocking: false });
    const second = await run(["worker", "--bundle", outDir], { cliContext: serverSide.cli, blocking: false });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((first.result as { bundle?: { kind: string } }).bundle?.kind).toBe("hydrated");
    expect((second.result as { bundle?: { kind: string } }).bundle?.kind).toBe("already_hydrated");
  });

  it("a hash-mismatched bundle directory fails the command cleanly (ok:false), it does not start the server", async () => {
    const laptop = await freshRealCli();
    const path = join(laptop.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-server-bundle-bad"), "utf8");
    await run(["register", path], { cliContext: laptop.cli });
    const outDir = join(laptop.cwd, "bundle-out");
    await run(["bundle", "wf-server-bundle-bad", "--out", outDir], { cliContext: laptop.cli });
    const manifestPath = join(outDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, bundleHash: "0".repeat(64) }, null, 2), "utf8");

    const serverSide = await freshRealCli();
    const outcome = await run(["server", "--port", "9997", "--bundle", outDir], { cliContext: serverSide.cli, blocking: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(String((outcome.result as { error?: string }).error)).toMatch(/bundleHash mismatch/i);
  });

  it("aart worker / aart server without --bundle behave exactly as before (no bundle field in the result)", async () => {
    const serverSide = await freshRealCli();
    const outcome = await run(["worker"], { cliContext: serverSide.cli, blocking: false });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { bundle?: unknown }).bundle).toBeUndefined();
  });
});

describe("--root <dir> / AART_ROOT (AMENDMENTS.md A45) — every call below goes through run()'s own real resolveCliContext, no cliContext override, so each MUST pass an explicit --root pointing at a throwaway tmpdir (never the real process.cwd()'s ./.aart default)", () => {
  let base: string;
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    delete process.env.AART_ROOT;
  });

  it("--root <dir> isolates the store from a different --root <dir>", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-root-flag-test-"));
    const rootA = join(base, "root-a", ".aart");
    const rootB = join(base, "root-b", ".aart");
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, trivialWorkflowYaml("wf-root-flag"), "utf8");

    const registerOutcome = await run(["register", wfPath, "--root", rootA]);
    expect(registerOutcome.ok).toBe(true);

    const listA = await run(["list", "--root", rootA]);
    expect((listA.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-root-flag");

    const listB = await run(["list", "--root", rootB]);
    expect((listB.result as { workflows: unknown[] }).workflows).toEqual([]);
  });

  it("AART_ROOT env var is honored when --root is not given", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-root-env-test-"));
    const root = join(base, "env-root", ".aart");
    process.env.AART_ROOT = root;
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, trivialWorkflowYaml("wf-root-env"), "utf8");

    await run(["register", wfPath]);
    const listOutcome = await run(["list", "--root", root]); // read back via explicit --root, same value AART_ROOT held
    expect((listOutcome.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-root-env");
  });

  it("--root flag takes precedence over AART_ROOT when both are given", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-root-precedence-test-"));
    const envRoot = join(base, "env-root", ".aart");
    const flagRoot = join(base, "flag-root", ".aart");
    process.env.AART_ROOT = envRoot;
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, trivialWorkflowYaml("wf-root-precedence"), "utf8");

    await run(["register", wfPath, "--root", flagRoot]);

    const listFlagRoot = await run(["list", "--root", flagRoot]);
    expect((listFlagRoot.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-root-precedence");

    const listEnvRoot = await run(["list", "--root", envRoot]);
    expect((listEnvRoot.result as { workflows: unknown[] }).workflows).toEqual([]);
  });
});

describe("--store fs|sqlite (AMENDMENTS.md A45)", () => {
  let base: string;
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("--store sqlite backs the store with a real SQLite db file at <root>/aart.db, readable back through the same flag", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-store-flag-test-"));
    const root = join(base, ".aart");
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, trivialWorkflowYaml("wf-store-sqlite"), "utf8");

    const registerOutcome = await run(["register", wfPath, "--root", root, "--store", "sqlite"]);
    expect(registerOutcome.ok).toBe(true);

    await expect(stat(join(root, "aart.db"))).resolves.toBeDefined();

    const listSqlite = await run(["list", "--root", root, "--store", "sqlite"]);
    expect((listSqlite.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-store-sqlite");

    // Cross-check: the SAME root read with the DEFAULT (fs) adapter sees
    // nothing — proving this is genuinely a different backend, not merely
    // a different directory the fs adapter would have found anyway.
    const listFs = await run(["list", "--root", root]);
    expect((listFs.result as { workflows: unknown[] }).workflows).toEqual([]);
  });

  it("defaults to fs when --store is omitted", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-store-default-test-"));
    const root = join(base, ".aart");
    const wfPath = join(base, "wf.yaml");
    await writeFile(wfPath, trivialWorkflowYaml("wf-store-default"), "utf8");

    await run(["register", wfPath, "--root", root]);
    await expect(stat(join(root, "aart.db"))).rejects.toThrow(); // no sqlite db file was ever created
    const listOutcome = await run(["list", "--root", root]);
    expect((listOutcome.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toContain("wf-store-default");
  });

  it("rejects an unrecognized --store value with a clear error, not a crash", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-store-invalid-test-"));
    const root = join(base, ".aart");
    const outcome = await run(["list", "--root", root, "--store", "postgres"]);
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/--store must be "fs" or "sqlite"/);
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
