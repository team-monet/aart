// Full CLI surface tests (spec §33's command list, plus this session's
// documented additions: bundle/flag/approve/mcp — see commands/*.ts module
// doc comments for the evidence behind each addition).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowInput, requestApprovalHandler, runWorkflowHandler as mcpRunWorkflowHandler, type ServerPort } from "@aart/mcp";
import { createFakeEngine, startServer, systemClock, type ServerHandle } from "@aart/server";
import { createFsStore } from "@aart/store";
import { afterEach, describe, expect, it } from "vitest";
import { run, USAGE, VERSION } from "./cli.js";
import { createCliContext, type CliContext } from "./cli-context.js";
import { approvalWaitWorkflowYaml, createTestCli, sampleWorkflowYaml, type TestCli } from "./test-utils.js";

let tc: TestCli;
let remoteServer: Server | undefined;
afterEach(async () => {
  await tc?.cleanup();
  if (remoteServer) await new Promise<void>((resolve) => remoteServer!.close(() => resolve()));
  remoteServer = undefined;
});

/** D1 "remotes + push" (AMENDMENTS.md A56) — a fake HTTP server standing in for a real `aart server`'s /bundles/ingest+/bundles/plan routes, mirroring handlers/deployment.test.ts's own fixture. */
function startFakeRemoteServer(): Promise<{ url: string; lastRequest: () => { path: string; authorization: string | undefined } | undefined }> {
  let captured: { path: string; authorization: string | undefined } | undefined;
  return new Promise((resolve, reject) => {
    remoteServer = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        captured = { path: req.url ?? "", authorization: req.headers.authorization };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ kind: "hydrated" }));
      });
    });
    remoteServer.once("error", reject);
    remoteServer.listen(0, () => {
      const address = remoteServer!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://localhost:${port}`, lastRequest: () => captured });
    });
  });
}

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

describe("aart report", () => {
  it("closes the CLI run-to-evidence loop without sending the user to an MCP-only tool", async () => {
    tc = await createTestCli();
    await tc.cli.aart.store.workflows.put(compileWorkflowInput(sampleWorkflowYaml("wf-cli-report")));
    const runOutcome = await run(["run", "wf-cli-report"], { cliContext: tc.cli });
    const runResult = runOutcome.result as { runId: string; next: string };
    expect(runResult.next).toContain(`\`aart report ${runResult.runId}\``);
    expect(runResult.next).not.toContain("aart_get_report");

    const reportOutcome = await run(["report", runResult.runId], { cliContext: tc.cli });
    expect(reportOutcome.ok).toBe(true);
    expect((reportOutcome.result as { report: { workflowId: string } }).report.workflowId).toBe("wf-cli-report");
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
    expect(config.mcpServers.aart.args).toEqual(expect.arrayContaining(["--root", tc.cli.root, "--store", "fs"]));
    const instructions = await readFile(instructionsOut, "utf8");
    expect(instructions).toContain("Shell runs and is forgotten");
    expect(instructions).toContain("aart_find_workflows");
  });

  describe("aart init-agent's generated MCP config — AMENDMENTS.md A54 (the npx-registry trap)", () => {
    it("defaults to the self-referencing `node <binPath> mcp` form, not `npx` — the actual fix: a real `aart` invocation always has a real process.argv[1] to point at", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      const outcome = await run(["init-agent", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });
      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.aart.command).toBe(process.execPath);
      expect(config.mcpServers.aart.args).toEqual([process.argv[1], "mcp", "--root", tc.cli.root, "--store", "fs"]);
    });

    it("--bin-path overrides the default explicitly", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      const outcome = await run(
        ["init-agent", "--bin-path", "/opt/aart/dist/bin.js", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")],
        { cliContext: tc.cli },
      );
      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.aart).toEqual({ command: process.execPath, args: ["/opt/aart/dist/bin.js", "mcp", "--root", tc.cli.root, "--store", "fs"] });
    });

    it("--npx opts back into the original registry-resolved form (correct once @team-monet/aart is genuinely published at a matching version)", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      const outcome = await run(["init-agent", "--npx", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });
      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.aart).toEqual({ command: "npx", args: ["-y", "@team-monet/aart", "mcp", "--root", tc.cli.root, "--store", "fs"] });
    });

    it("--npx --package names a different registry package", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      const outcome = await run(
        ["init-agent", "--npx", "--package", "@custom/aart", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")],
        { cliContext: tc.cli },
      );
      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.aart.args).toEqual(["-y", "@custom/aart", "mcp", "--root", tc.cli.root, "--store", "fs"]);
    });

    it("pins sqlite when init-agent is invoked with --store sqlite", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      const outcome = await run(["init-agent", "--npx", "--store", "sqlite", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });
      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.aart.args).toEqual(["-y", "@team-monet/aart", "mcp", "--root", tc.cli.root, "--store", "sqlite"]);
    });
  });

  it("aart init-agent --help is read-only and returns command-specific usage", async () => {
    tc = await createTestCli();
    const outcome = await run(["init-agent", "--help", "--cwd", tc.cwd], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect(String((outcome.result as { usage?: string }).usage)).toContain("pins the resolved absolute --root");
    await expect(stat(join(tc.cwd, ".mcp.json"))).rejects.toThrow();
    await expect(stat(join(tc.cwd, "AGENTS.md"))).rejects.toThrow();
  });

  it("aart init-agent rejects misspelled flags before writing", async () => {
    tc = await createTestCli();
    const outcome = await run(["init-agent", "--hepl", "--cwd", tc.cwd], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect(String((outcome.result as { error?: string }).error)).toContain("Unknown init-agent flag");
    await expect(stat(join(tc.cwd, ".mcp.json"))).rejects.toThrow();
  });

  describe("aart init-agent's .mcp.json write is merge-safe, not clobbering (this session's own fix — with-aart/bootstrap/install.md's Phase 3 depends on this)", () => {
    it("preserves a sibling MCP server entry already in .mcp.json (e.g. a pre-existing `monet` registration) instead of deleting it", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      await writeFile(mcpConfigOut, JSON.stringify({ mcpServers: { monet: { command: "monet", args: ["start"] } } }, null, 2), "utf8");

      const outcome = await run(["init-agent", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });

      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config.mcpServers.monet).toEqual({ command: "monet", args: ["start"] });
      expect(config.mcpServers.aart.args).toContain("mcp");
    });

    it("re-running init-agent updates the aart entry in place (idempotent refresh, AUTHORING.md part (f)) without duplicating or dropping the sibling entry", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      await writeFile(mcpConfigOut, JSON.stringify({ mcpServers: { monet: { command: "monet", args: ["start"] } } }, null, 2), "utf8");

      await run(["init-agent", "--bin-path", "/opt/aart-old/dist/bin.js", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });
      const second = await run(
        ["init-agent", "--bin-path", "/opt/aart-new/dist/bin.js", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")],
        { cliContext: tc.cli },
      );

      expect(second.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(Object.keys(config.mcpServers).sort()).toEqual(["aart", "monet"]);
      expect(config.mcpServers.aart).toEqual({ command: process.execPath, args: ["/opt/aart-new/dist/bin.js", "mcp", "--root", tc.cli.root, "--store", "fs"] });
      expect(config.mcpServers.monet).toEqual({ command: "monet", args: ["start"] });
    });

    it("preserves top-level keys outside mcpServers in the existing file", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      await writeFile(mcpConfigOut, JSON.stringify({ _comment: "hand-maintained", mcpServers: {} }, null, 2), "utf8");

      const outcome = await run(["init-agent", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });

      expect(outcome.ok).toBe(true);
      const config = JSON.parse(await readFile(mcpConfigOut, "utf8"));
      expect(config._comment).toBe("hand-maintained");
    });

    it("an existing .mcp.json that isn't valid JSON fails loudly and is left on disk untouched, rather than being silently overwritten", async () => {
      tc = await createTestCli();
      const mcpConfigOut = join(tc.cwd, ".mcp.json");
      await writeFile(mcpConfigOut, "{not valid json", "utf8");

      const outcome = await run(["init-agent", "--mcp-config-out", mcpConfigOut, "--instructions-out", join(tc.cwd, "AGENTS.md")], {
        cliContext: tc.cli,
      });

      expect(outcome.ok).toBe(false);
      expect(String((outcome.result as { error?: string }).error)).toContain("not valid JSON");
      expect(await readFile(mcpConfigOut, "utf8")).toBe("{not valid json"); // untouched
    });
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

describe("aart find-workflows", () => {
  it("finds a reusable workflow by metadata through the same MCP handler", async () => {
    tc = await createTestCli();
    await tc.cli.aart.store.workflows.put(compileWorkflowInput(sampleWorkflowYaml("reusable-release-check")));
    const outcome = await run(["find-workflows", "release"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { workflows: Array<{ id: string }> }).workflows).toEqual([
      expect.objectContaining({ id: "reusable-release-check" }),
    ]);
  });
});

describe("aart find-blocks", () => {
  it("searches the same local catalog as MCP and keeps the next action executable in the CLI", async () => {
    tc = await createTestCli();
    const outcome = await run(["find-blocks", "browser"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { blocks: Array<{ id: string }> }).blocks.length).toBeGreaterThan(0);
    expect((outcome.result as { next: string }).next).toContain("`aart find-workflows`");
    expect((outcome.result as { next: string }).next).not.toContain("aart_find_workflows");
  });

  it("turns a workflow-search miss into a command the same CLI can actually run", async () => {
    tc = await createTestCli();
    const outcome = await run(["find-workflows", "not-present-anywhere"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { matched: boolean }).matched).toBe(false);
    expect((outcome.result as { next: string }).next).toContain("`aart find-blocks`");
    expect((outcome.result as { next: string }).next).not.toContain("aart_find_blocks");
  });

  it("treats a Block-search miss as a successful search and offers full-catalog browsing", async () => {
    tc = await createTestCli();
    const outcome = await run(["find-blocks", "xyzzyqwertycapability"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { matched: boolean }).matched).toBe(false);
    expect((outcome.result as { next: string }).next).toContain("`aart find-blocks` without a query");
  });
});

describe("aart pack", () => {
  it("does not offer an install command for preview catalog fixtures", async () => {
    tc = await createTestCli();
    const indexUrl = `data:application/json,${encodeURIComponent(
      JSON.stringify({
        schemaVersion: 1,
        mode: "preview",
        packs: [
          {
            npmPackageName: "aart-pack-preview-demo",
            packName: "preview-demo",
            version: "1.0.0",
            blocks: [],
          },
        ],
      }),
    )}`;
    const outcome = await run(
      ["pack", "search", "preview", "--index-url", indexUrl],
      { cliContext: tc.cli },
    );
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { indexMode: string }).indexMode).toBe("preview");
    expect((outcome.result as { next: string }).next).toContain("preview catalog fixtures");
    expect((outcome.result as { next: string }).next).not.toContain("aart pack add");
  });

  it("adds a workflow-only Pack inertly, lists it, then registers its workflow only after human approval", async () => {
    tc = await createTestCli();
    const packDir = join(tc.cwd, "aart-pack-cli-reuse");
    await mkdir(join(packDir, "workflows"), { recursive: true });
    await writeFile(
      join(packDir, "aart-pack.yaml"),
      "name: cli-reuse\nversion: 1.0.0\nworkflows: [cli-reusable-flow]\n",
      "utf8",
    );
    await writeFile(
      join(packDir, "package.json"),
      JSON.stringify({ name: "aart-pack-cli-reuse", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(join(packDir, "workflows", "cli-reusable-flow.yaml"), sampleWorkflowYaml("cli-reusable-flow", "1.0.0"), "utf8");

    const added = await run(["pack", "add", "cli-reuse", "--from", packDir], { cliContext: tc.cli });
    expect(added.ok).toBe(true);
    expect((added.result as { approvalStatus: string }).approvalStatus).toBe("unapproved");
    expect((added.result as { next: string }).next).toContain("`aart pack list --status unapproved`");
    expect(await tc.cli.aart.store.workflows.getLatest("cli-reusable-flow")).toBeUndefined();

    const listed = await run(["pack", "list", "--status", "unapproved"], { cliContext: tc.cli });
    expect((listed.result as { count: number }).count).toBe(1);
    expect((listed.result as { next: string }).next).toContain(
      `--content-hash ${(added.result as { contentHash: string }).contentHash}`,
    );

    const approved = await run(
      [
        "pack",
        "approve",
        "cli-reuse",
        "--version",
        "1.0.0",
        "--content-hash",
        (added.result as { contentHash: string }).contentHash,
        "--reviewer",
        "alice",
      ],
      { cliContext: tc.cli },
    );
    expect(approved.ok).toBe(true);
    expect((await tc.cli.aart.store.workflows.getLatest("cli-reusable-flow"))?.approval).toBe("draft");
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

// D1 "remotes + push" (AMENDMENTS.md A56).
describe("aart remote add / list / remove", () => {
  it("round-trips a remote through add -> list -> remove", async () => {
    tc = await createTestCli();
    const addOutcome = await run(["remote", "add", "production", "https://prod.example.com", "--environment", "production", "--token-ref", "secrets.PROD_TOKEN"], { cliContext: tc.cli });
    expect(addOutcome.ok).toBe(true);
    expect((addOutcome.result as { remote: { name: string; url: string; environment: string; tokenRef: string } }).remote).toEqual({
      name: "production",
      url: "https://prod.example.com",
      environment: "production",
      tokenRef: "secrets.PROD_TOKEN",
    });

    const listOutcome = await run(["remote", "list"], { cliContext: tc.cli });
    expect(listOutcome.ok).toBe(true);
    expect((listOutcome.result as { remotes: unknown[] }).remotes).toHaveLength(1);

    const removeOutcome = await run(["remote", "remove", "production"], { cliContext: tc.cli });
    expect(removeOutcome.ok).toBe(true);
    const listAfterRemove = await run(["remote", "list"], { cliContext: tc.cli });
    expect((listAfterRemove.result as { remotes: unknown[] }).remotes).toEqual([]);
  });

  it("tokenRef is optional — add without it round-trips fine", async () => {
    tc = await createTestCli();
    const addOutcome = await run(["remote", "add", "dev", "http://localhost:8080", "--environment", "dev"], { cliContext: tc.cli });
    expect(addOutcome.ok).toBe(true);
    expect((addOutcome.result as { remote: { tokenRef?: string } }).remote.tokenRef).toBeUndefined();
  });

  it("remove fails cleanly for an unknown remote name", async () => {
    tc = await createTestCli();
    const outcome = await run(["remote", "remove", "no-such-remote"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });

  it("--environment is required for add", async () => {
    tc = await createTestCli();
    const outcome = await run(["remote", "add", "production", "https://prod.example.com"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });

  // D1 fix pass (AMENDMENTS.md A57) — a plain http:// remote (anything
  // but localhost/loopback) sends the deploy token cleartext; `aart remote
  // add` never touches the network (it only writes remotes.json), making
  // this the cheapest place to catch it, before any real push. Tested here
  // (not through deployToRemoteHandler's own network path) because it
  // needs zero network I/O to exercise both branches reliably.
  it("warns about cleartext token exposure when the URL is http:// and not localhost/loopback", async () => {
    tc = await createTestCli();
    const outcome = await run(["remote", "add", "insecure", "http://deploy.example.com", "--environment", "prod"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { warning?: string };
    expect(result.warning).toMatch(/cleartext|unencrypted/i);
    expect(result.warning).toContain("http://deploy.example.com");
  });

  it("no warning for https://, and no warning for http://localhost or http://127.0.0.1", async () => {
    tc = await createTestCli();
    const httpsOutcome = await run(["remote", "add", "secure", "https://deploy.example.com", "--environment", "prod"], { cliContext: tc.cli });
    expect((httpsOutcome.result as { warning?: string }).warning).toBeUndefined();

    const localhostOutcome = await run(["remote", "add", "local1", "http://localhost:9999", "--environment", "dev"], { cliContext: tc.cli });
    expect((localhostOutcome.result as { warning?: string }).warning).toBeUndefined();

    const loopbackOutcome = await run(["remote", "add", "local2", "http://127.0.0.1:9999", "--environment", "dev"], { cliContext: tc.cli });
    expect((loopbackOutcome.result as { warning?: string }).warning).toBeUndefined();
  });
});

describe("aart push", () => {
  it("pushes a registered workflow version to the named remote", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-push"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const remote = await startFakeRemoteServer();
    await run(["remote", "add", "staging", remote.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const pushOutcome = await run(["push", "staging", "wf-cli-push"], { cliContext: tc.cli });
    expect(pushOutcome.ok).toBe(true);
    expect(remote.lastRequest()?.path).toBe("/bundles/ingest");
  });

  it("--plan targets /bundles/plan instead of /bundles/ingest", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-push-plan"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const remote = await startFakeRemoteServer();
    await run(["remote", "add", "staging", remote.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const pushOutcome = await run(["push", "staging", "wf-cli-push-plan", "--plan"], { cliContext: tc.cli });
    expect(pushOutcome.ok).toBe(true);
    expect(remote.lastRequest()?.path).toBe("/bundles/plan");
  });

  it("resolves --version to the latest registered version when omitted", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-push-latest", "0.2.0"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const remote = await startFakeRemoteServer();
    await run(["remote", "add", "staging", remote.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const pushOutcome = await run(["push", "staging", "wf-cli-push-latest"], { cliContext: tc.cli });
    expect(pushOutcome.ok).toBe(true);
  });

  it("fails cleanly with a remedy when the remote isn't configured", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-push-noremote"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const outcome = await run(["push", "no-such-remote", "wf-cli-push-noremote"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/aart remote add/i);
  });

  it("calls the exact same handler function MCP's aart_deploy tool calls (same-function-reference, not a reimplementation)", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-push-ref"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const remote = await startFakeRemoteServer();
    await run(["remote", "add", "staging", remote.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const { deployToRemoteHandler } = await import("@aart/mcp");
    const viaDirectHandler = await deployToRemoteHandler(tc.cli.aart, { remote: "staging", workflowId: "wf-cli-push-ref", workflowVersion: "0.1.0" });
    const viaCli = await run(["push", "staging", "wf-cli-push-ref"], { cliContext: tc.cli });
    expect((viaCli.result as { ok: boolean }).ok).toBe(viaDirectHandler.ok);
  });
});

// D2b "remote reads" (AMENDMENTS.md, this session) — aart remote-status/
// remote-why/remote-runs/remote-run. Unlike `startFakeRemoteServer` above
// (a hand-rolled stub good enough for /bundles/ingest's single fixed
// response), these four commands read SIX different real GET routes with
// real response shapes their handlers actually parse — a REAL @aart/server
// instance is used as the remote here too, same choice
// remote-observability.test.ts (@aart/mcp) already made and the same
// reasoning: a hand-mocked server covering all six routes would risk
// silently drifting from what they actually return. Thin-wrapper smoke
// coverage only (one happy path + one arg-parsing/error-path check per
// command) — the handlers' own full behavioral coverage already lives in
// that @aart/mcp test file; this suite only proves the CLI layer parses
// args and dispatches to the right handler correctly.
describe("aart remote-status / remote-why / remote-runs / remote-run (D2b, AMENDMENTS.md this session)", () => {
  let remoteHandle: ServerHandle | undefined;
  afterEach(async () => {
    await remoteHandle?.close();
    remoteHandle = undefined;
  });

  async function startRealRemote(): Promise<string> {
    const remoteRoot = await mkdtemp(join(tmpdir(), "aart-cli-remote-"));
    const store = createFsStore(remoteRoot);
    const engine = createFakeEngine(store, systemClock);
    remoteHandle = await startServer({ store, engine, clock: systemClock, port: 0, runTicker: false });
    return `http://127.0.0.1:${remoteHandle.port}`;
  }

  it("aart remote-status <workflowId> --remote <name>: reports drift against the named remote", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-remote-status"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const remoteUrl = await startRealRemote();
    await run(["remote", "add", "staging", remoteUrl, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["remote-status", "wf-cli-remote-status", "--remote", "staging"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const remotes = (outcome.result as { remotes: Array<{ remote: string; reachable: boolean }> }).remotes;
    expect(remotes).toEqual([expect.objectContaining({ remote: "staging", reachable: true })]);
  });

  it("aart remote-status <workflowId> (no --remote): iterates every configured remote", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-remote-status-all"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const remoteUrl = await startRealRemote();
    await run(["remote", "add", "staging", remoteUrl, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["remote-status", "wf-cli-remote-status-all"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { remotes: unknown[] }).remotes).toHaveLength(1);
  });

  it("aart remote-why <remote> <workflowId>: live:false with a clear note when nothing's been pushed", async () => {
    tc = await createTestCli();
    const remoteUrl = await startRealRemote();
    await run(["remote", "add", "staging", remoteUrl, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["remote-why", "staging", "wf-cli-remote-why"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { live: boolean }).live).toBe(false);
  });

  it("aart remote-runs <remote> [--status <status>]: lists compact run summaries, filtered", async () => {
    tc = await createTestCli();
    const remoteUrl = await startRealRemote();
    await run(["remote", "add", "staging", remoteUrl, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["remote-runs", "staging", "--status", "failed"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect((outcome.result as { runs: unknown[] }).runs).toEqual([]);
  });

  it("aart remote-run <remote> <runId>: fails cleanly (not found) rather than throwing when the run doesn't exist", async () => {
    tc = await createTestCli();
    const remoteUrl = await startRealRemote();
    await run(["remote", "add", "staging", remoteUrl, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["remote-run", "staging", "no-such-run"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/not found/i);
  });

  it("remote-why / remote-runs / remote-run fail cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-remote-noremote"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    for (const argv of [
      ["remote-why", "no-such-remote", "wf-cli-remote-noremote"],
      ["remote-runs", "no-such-remote"],
      ["remote-run", "no-such-remote", "run-1"],
    ]) {
      const outcome = await run(argv, { cliContext: tc.cli });
      expect(outcome.ok, argv.join(" ")).toBe(false);
      expect((outcome.result as { error: string }).error, argv.join(" ")).toMatch(/aart remote add/i);
    }
  });

  // remote-status is the deliberate exception: unlike the other three, an
  // unconfigured remote is scoped to THAT remote's own row
  // ({reachable:false, error}), not a whole-call failure — it supports
  // iterating every configured remote at once, and one bad name shouldn't
  // hide every other remote's real status (remote-observability.ts's own
  // doc comment on statusForOneRemote).
  it("remote-status reports an unconfigured remote as a reachable:false ROW, not a whole-call failure", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-remote-status-noremote"), "utf8");
    await run(["register", path], { cliContext: tc.cli });

    const outcome = await run(["remote-status", "wf-cli-remote-status-noremote", "--remote", "no-such-remote"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const remotes = (outcome.result as { remotes: Array<{ reachable: boolean; error?: string }> }).remotes;
    expect(remotes).toEqual([expect.objectContaining({ reachable: false, error: expect.stringMatching(/aart remote add/i) })]);
  });
});

// Wave 2C (AMENDMENTS.md A65) — aart approve-remote, the WRITE-against-
// remote half D2b (A62) deferred. Thin-wrapper smoke coverage only (the
// handler's own full behavioral coverage — genuine per-run wait, workflow-
// version gate decoding, deploy-token matrix — already lives in
// packages/mcp/src/handlers/remote-governance.test.ts, matching the exact
// division of labor the "remote-status/.../remote-run" describe block above
// already established for its own four sibling commands); a REAL
// @aart/server instance stands in for the remote here too, same reasoning.
describe("aart approve-remote — the REMOTE counterpart of aart approve (Wave 2C, AMENDMENTS.md A65)", () => {
  let remoteHandle: ServerHandle | undefined;
  afterEach(async () => {
    await remoteHandle?.close();
    remoteHandle = undefined;
  });

  async function startRealRemote(): Promise<{ url: string; store: ReturnType<typeof createFsStore> }> {
    const remoteRoot = await mkdtemp(join(tmpdir(), "aart-cli-approve-remote-"));
    const store = createFsStore(remoteRoot);
    const engine = createFakeEngine(store, systemClock);
    remoteHandle = await startServer({ store, engine, clock: systemClock, port: 0, runTicker: false });
    return { url: `http://127.0.0.1:${remoteHandle.port}`, store };
  }

  it("aart approve-remote <remote> <taskId> --decision approved --reviewer <name>: decides a workflow-version gate on the remote", async () => {
    tc = await createTestCli();
    const remoteConn = await startRealRemote();
    await remoteConn.store.workflows.put({
      id: "wf-cli-approve-remote",
      name: "Test",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "draft",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "waived", humanReview: "pending" },
    });
    const { runId, stepId } = tc.cli.aart.governance.workflowVersionApprovalSubject("wf-cli-approve-remote", "1.0.0", "humanReview");
    await remoteConn.store.approvals.put({ id: "task-cli-1", runId, stepId, title: "t", description: "d", status: "pending", createdAt: new Date().toISOString() });
    await run(["remote", "add", "staging", remoteConn.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const outcome = await run(["approve-remote", "staging", "task-cli-1", "--decision", "approved", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    const result = outcome.result as { kind: string; gates: { humanReview: string }; approval: string };
    expect(result.kind).toBe("workflow_version");
    expect(result.gates.humanReview).toBe("passed");
    expect(result.approval).toBe("approved");

    const persisted = await remoteConn.store.approvals.get("task-cli-1");
    expect(persisted?.status).toBe("approved");
    expect(persisted?.reviewer).toBe("alice");
  });

  it("rejects an invalid --decision value, without ever reaching the remote", async () => {
    tc = await createTestCli();
    const outcome = await run(["approve-remote", "staging", "task_x", "--decision", "maybe", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });

  it("fails cleanly with a remedy when the named remote isn't configured", async () => {
    tc = await createTestCli();
    const outcome = await run(["approve-remote", "no-such-remote", "task_x", "--decision", "approved", "--reviewer", "alice"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
    expect((outcome.result as { error: string }).error).toMatch(/aart remote add/i);
  });

  it("calls the exact same handler function MCP's aart_remote_approve tool calls (same-function-reference, not a reimplementation)", async () => {
    tc = await createTestCli();
    const remoteConn = await startRealRemote();
    await remoteConn.store.workflows.put({
      id: "wf-cli-approve-remote-ref",
      name: "Test",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "draft",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "waived", humanReview: "pending" },
    });
    const { runId, stepId } = tc.cli.aart.governance.workflowVersionApprovalSubject("wf-cli-approve-remote-ref", "1.0.0", "humanReview");
    await remoteConn.store.approvals.put({ id: "task-cli-ref", runId, stepId, title: "t", description: "d", status: "pending", createdAt: new Date().toISOString() });
    await run(["remote", "add", "staging", remoteConn.url, "--environment", "staging-env"], { cliContext: tc.cli });

    const { remoteApproveHandler } = await import("@aart/mcp");
    const viaCli = await run(["approve-remote", "staging", "task-cli-ref", "--decision", "rejected", "--reviewer", "bob"], { cliContext: tc.cli });
    expect(viaCli.ok).toBe(true);
    // The CLI call above already decided the task -- calling the handler a
    // second time directly proves it's the SAME function CLI dispatches to
    // (three-clients precedent), not a parallel reimplementation: a stale
    // "already decided, wrong gate state" bug in a duplicate implementation
    // would surface here as a mismatched result shape.
    const viaDirectHandler = await remoteApproveHandler(tc.cli.aart, { remote: "staging", taskId: "task-cli-ref", decision: "rejected", reviewer: "bob" });
    expect(viaDirectHandler.kind).toBe(viaCli.result && (viaCli.result as { kind: string }).kind);
  });
});

describe("aart environment register / list — ADR-2 (AMENDMENTS.md A56)", () => {
  it("registers an environment with a trust mode, visible via list", async () => {
    tc = await createTestCli();
    const registerOutcome = await run(["environment", "register", "production", "--trust-mode", "production"], { cliContext: tc.cli });
    expect(registerOutcome.ok).toBe(true);
    expect((registerOutcome.result as { environment: { name: string; config: Record<string, unknown> } }).environment.config["trustMode"]).toBe("production");

    const listOutcome = await run(["environment", "list"], { cliContext: tc.cli });
    expect(listOutcome.ok).toBe(true);
    const environments = (listOutcome.result as { environments: Array<{ name: string }> }).environments;
    expect(environments.some((e) => e.name === "production")).toBe(true);
  });

  it("rejects an invalid --trust-mode with a clear error", async () => {
    tc = await createTestCli();
    const outcome = await run(["environment", "register", "staging", "--trust-mode", "not-a-real-mode"], { cliContext: tc.cli });
    expect(outcome.ok).toBe(false);
  });

  it("re-registering the same name upserts (updates trustMode) rather than duplicating", async () => {
    tc = await createTestCli();
    await run(["environment", "register", "staging", "--trust-mode", "governed"], { cliContext: tc.cli });
    await run(["environment", "register", "staging", "--trust-mode", "strict"], { cliContext: tc.cli });
    const listOutcome = await run(["environment", "list"], { cliContext: tc.cli });
    const environments = (listOutcome.result as { environments: Array<{ name: string; config: Record<string, unknown> }> }).environments;
    const staging = environments.filter((e) => e.name === "staging");
    expect(staging).toHaveLength(1);
    expect(staging[0]?.config["trustMode"]).toBe("strict");
  });

  it("this is the REAL wiring for the previously-dead registerEnvironment — a workflow can actually be promoted into a freshly-registered environment", async () => {
    tc = await createTestCli();
    const path = join(tc.cwd, "wf.yaml");
    await writeFile(path, sampleWorkflowYaml("wf-cli-env-promote"), "utf8");
    await run(["register", path], { cliContext: tc.cli });
    const wf = await tc.cli.aart.store.workflows.get("wf-cli-env-promote", "0.1.0");
    await tc.cli.aart.store.workflows.put({ ...wf!, gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" } });
    await run(["promote", "wf-cli-env-promote"], { cliContext: tc.cli });

    await run(["environment", "register", "staging-real", "--trust-mode", "governed"], { cliContext: tc.cli });
    const deployOutcome = await run(["deploy", "wf-cli-env-promote", "--target", "staging-real"], { cliContext: tc.cli });
    expect(deployOutcome.ok).toBe(true);
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

  it("a fresh destination restores bundled Pack code before constructing its runtime catalog", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-pack-bundle-"));
    const sourceRoot = join(base, "source", ".aart");
    const packDir = join(base, "aart-pack-demo");
    await mkdir(join(packDir, "blocks"), { recursive: true });
    await writeFile(join(packDir, "aart-pack.yaml"), "name: demo\nversion: 1.0.0\nblocks: [demo.echo]\n", "utf8");
    await writeFile(
      join(packDir, "package.json"),
      JSON.stringify({ name: "aart-pack-demo", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(packDir, "blocks", "demo.echo.cjs"),
      `module.exports = {
        manifest: {
          id: "demo.echo",
          version: "1.0.0",
          capabilities: [],
          inputSchema: {},
          outputSchema: {},
          description: "Echo a value"
        },
        execute: (input) => ({ value: input.value })
      };`,
      "utf8",
    );
    const added = await run(["pack", "add", "demo", "--from", packDir, "--root", sourceRoot]);
    expect(added.ok).toBe(true);
    const contentHash = (added.result as { contentHash: string }).contentHash;
    const approved = await run([
      "pack",
      "approve",
      "demo",
      "--version",
      "1.0.0",
      "--content-hash",
      contentHash,
      "--reviewer",
      "bundle-e2e",
      "--root",
      sourceRoot,
    ]);
    expect(approved.ok).toBe(true);

    const workflowPath = join(base, "pack-workflow.yaml");
    await writeFile(
      workflowPath,
      `id: bundled-pack-wf
name: Bundled Pack Workflow
version: 1.0.0
inputs:
  value:
    type: string
    required: true
steps:
  - id: echo
    uses: demo.echo
    with:
      value: "{{ inputs.value }}"
`,
      "utf8",
    );
    expect((await run(["register", workflowPath, "--root", sourceRoot])).ok).toBe(true);
    const outDir = join(base, "bundle-out");
    expect((await run(["bundle", "bundled-pack-wf", "--out", outDir, "--root", sourceRoot])).ok).toBe(true);

    const destinationRoot = join(base, "fresh", ".aart");
    const started = await run(
      ["server", "--port", "0", "--root", destinationRoot, "--bundle", outDir],
      { blocking: false },
    );
    expect(started.ok).toBe(true);
    const executed = await run([
      "run",
      "bundled-pack-wf",
      "--input",
      '{"value":"hello"}',
      "--root",
      destinationRoot,
    ]);
    expect(executed.ok).toBe(true);
    expect((executed.result as { status: string }).status).toBe("completed");
  });

  it("an explicit cliContext override bypasses the check entirely (this package's own fast unit tests, which never point at a real --root)", async () => {
    tc = await createTestCli(); // tc.root is a real tmpdir but NEVER passed as --root here
    const outcome = await run(["server", "--port", "0"], { cliContext: tc.cli, blocking: false });
    expect(outcome.ok).toBe(true);
  });
});

// D2a security hardening, breaking-change bind default (AMENDMENTS.md A59)
// — proves --host/AART_HOST actually flows all the way from argv through
// run() -> serverCommand (commands/process.ts) -> cli.serverPort.startServer
// -> the REAL bind, not just that serverCommand builds the right config
// object. Needs the REAL composition (createCliContext WITHOUT `real:
// false`, same reasoning as the S12 deploy-story block below) — the stub
// ServerPort never binds a real socket at all, so there'd be nothing to
// observe. serverCommand's own non-blocking mode calls handle.close()
// immediately after starting it, before run() ever returns — there is no
// window to inspect the live socket through run()'s own return value alone,
// so this wraps the REAL ServerPort to capture the bound address the
// instant the real startServer resolves, before handing the handle back to
// serverCommand (which then proceeds to close it, same as it always would).
describe("aart server --host / AART_HOST (D2a security hardening, AMENDMENTS.md A59)", () => {
  let base: string;
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    delete process.env.AART_HOST;
  });

  function captureBoundHost(realPort: ServerPort): { port: ServerPort; seen: () => string | undefined } {
    let seen: string | undefined;
    return {
      seen: () => seen,
      port: {
        ...realPort,
        async startServer(config) {
          const handle = await realPort.startServer(config);
          const server = (handle as unknown as { server: import("node:net").Server }).server;
          const address = server.address();
          seen = typeof address === "object" && address ? address.address : undefined;
          return handle;
        },
      },
    };
  }

  it("--host threads through the real CLI entry (run -> serverCommand -> cli.serverPort.startServer -> the real bind)", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-host-flag-"));
    const root = join(base, ".aart");
    await mkdir(root, { recursive: true });
    const realCli = createCliContext({ root, trustMode: "governed" });
    const capture = captureBoundHost(realCli.serverPort);

    const outcome = await run(["server", "--host", "0.0.0.0", "--port", "0"], { cliContext: { ...realCli, serverPort: capture.port }, blocking: false });

    expect(outcome.ok).toBe(true);
    expect(capture.seen()).toBe("0.0.0.0");
  });

  it("AART_HOST env var is honored the same way --host is; --host wins when both are given (mirrors --environment/AART_ENVIRONMENT's own established precedence)", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-host-env-"));
    const root = join(base, ".aart");
    await mkdir(root, { recursive: true });
    const realCli = createCliContext({ root, trustMode: "governed" });

    process.env.AART_HOST = "0.0.0.0";
    const capture1 = captureBoundHost(realCli.serverPort);
    const outcome1 = await run(["server", "--port", "0"], { cliContext: { ...realCli, serverPort: capture1.port }, blocking: false });
    expect(outcome1.ok).toBe(true);
    expect(capture1.seen()).toBe("0.0.0.0");

    const capture2 = captureBoundHost(realCli.serverPort);
    const outcome2 = await run(["server", "--host", "127.0.0.1", "--port", "0"], { cliContext: { ...realCli, serverPort: capture2.port }, blocking: false });
    expect(outcome2.ok).toBe(true);
    expect(capture2.seen()).toBe("127.0.0.1"); // flag wins over env
  });

  it("omitting both --host and AART_HOST leaves the default (loopback) in effect", async () => {
    base = await mkdtemp(join(tmpdir(), "aart-server-host-default-"));
    const root = join(base, ".aart");
    await mkdir(root, { recursive: true });
    const realCli = createCliContext({ root, trustMode: "governed" });
    const capture = captureBoundHost(realCli.serverPort);

    const outcome = await run(["server", "--port", "0"], { cliContext: { ...realCli, serverPort: capture.port }, blocking: false });
    expect(outcome.ok).toBe(true);
    expect(capture.seen()).toBe("127.0.0.1");
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

// AMENDMENTS.md A63 FIX 7 (optional/low-priority, tester UX) — pre-fix,
// "--help"/"-h"/"help" fell through to the exact same `default:` case as a
// genuinely unknown command ("frobnicate", above): ok:false, exitCode 1,
// and a misleading `error: 'Unknown command "--help".'` — even though
// `usage` (the correct block) was already present in the result. This
// describe block proves `run()` itself no longer misclassifies these three
// as unknown commands. The real `aart` binary (bin.ts) additionally
// short-circuits before ever calling `run()`, printing USAGE as plain
// stdout text at exit 0 (mirroring bin.ts's own pre-existing zero-arg
// special case) — not exercised here, since bin.ts is a top-level-await
// process entry point with no exported function to call directly.
describe("--help / -h / help (AMENDMENTS.md A63 FIX 7)", () => {
  it.each(["--help", "-h", "help"])("%s returns ok:true with the USAGE block, not a false 'unknown command'", async (arg) => {
    tc = await createTestCli();
    const outcome = await run([arg], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect((outcome.result as { usage: string }).usage).toBe(USAGE);
    expect(JSON.stringify(outcome.result)).not.toMatch(/Unknown command/);
  });
});

// AMENDMENTS.md A68 (0.10.0 release prep) — `aart --version`/`-v` did not
// exist anywhere in this CLI's surface before this release (root
// AMENDMENTS.md A54's own finding, reconfirmed: "`aart --version` isn't a
// real command in this CLI's surface — the `USAGE` string has no such
// flag"). Same shape as the --help/-h/help describe block immediately
// above: proves `run()` itself reports the real VERSION with a genuine
// ok:true, not a false "unknown command". bin.ts's own real-process
// short-circuit (plain stdout text, exit 0) is not exercised here for the
// same reason the --help short-circuit above isn't — it's a top-level-await
// process entry point with no exported function to call directly.
describe("--version / -v (AMENDMENTS.md A68)", () => {
  it.each(["--version", "-v"])("%s returns ok:true with the real VERSION, not a false 'unknown command'", async (arg) => {
    tc = await createTestCli();
    const outcome = await run([arg], { cliContext: tc.cli });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect((outcome.result as { version: string }).version).toBe(VERSION);
    expect(JSON.stringify(outcome.result)).not.toMatch(/Unknown command/);
  });
});
