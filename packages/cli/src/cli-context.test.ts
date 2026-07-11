// createCliContext's real/stub composition split (AMENDMENTS.md A42).
//
// Verifies the DEFAULT is genuinely the real engine + real ServerPort (not
// merely "typechecks as real") by exercising behavior only the real
// implementations exhibit — stubs/engine.ts's own doc comment is explicit
// that its simulation "every other step completes immediately with empty
// outputs", so a genuinely-failing assert.equals step only actually fails
// the run under the REAL engine, never the stub. Same idea for
// real-server-port.ts's new environment-name -> Deployment bridge: the
// stub's produceBundle never even looks at `environment` (stubs/server.ts),
// so only the real ServerPort can reject an unknown environment name.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowInput, runWorkflowHandler } from "@aart/mcp";
import { afterEach, describe, expect, it } from "vitest";
import { createCliContext } from "./cli-context.js";

function failingAssertWorkflow(id: string) {
  return {
    id,
    name: "Assertion Probe (cli-context.test.ts)",
    version: "0.1.0",
    steps: [{ id: "check", uses: "assert.equals", with: { actual: "a", expected: "b" } }],
  };
}

let cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.map((p) => fs.rm(p, { recursive: true, force: true })));
  cleanupPaths = [];
});

async function freshRoot(): Promise<string> {
  const base = await fs.mkdtemp(join(tmpdir(), "aart-cli-context-"));
  cleanupPaths.push(base);
  return join(base, ".aart");
}

describe("createCliContext", () => {
  it("defaults to the REAL engine — a genuinely-failing assertion genuinely fails the run", async () => {
    const root = await freshRoot();
    const cli = createCliContext({ root, trustMode: "governed" });
    const workflow = compileWorkflowInput(failingAssertWorkflow("wf-real-default"));
    await cli.aart.store.workflows.put(workflow);
    const result = await runWorkflowHandler(cli.aart, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.status).toBe("failed");
  });

  it("{ real: false } gives back the fast stub engine this package's own test suite depends on", async () => {
    const root = await freshRoot();
    const cli = createCliContext({ root, trustMode: "governed", real: false });
    const workflow = compileWorkflowInput(failingAssertWorkflow("wf-stub-opt-out"));
    await cli.aart.store.workflows.put(workflow);
    const result = await runWorkflowHandler(cli.aart, { workflowId: workflow.id, workflowVersion: workflow.version });
    // The stub never evaluates assert.equals for real (stubs/engine.ts:
    // "every other step 'completes' immediately with empty outputs") — the
    // run reaches the end without the assertion ever genuinely running.
    expect(result.status).toBe("completed");
  });

  it("real ServerPort.produceBundle rejects an --environment name that doesn't exist (the environment-name -> Deployment bridge, A42)", async () => {
    const root = await freshRoot();
    const cli = createCliContext({ root, trustMode: "governed" });
    const workflow = compileWorkflowInput(failingAssertWorkflow("wf-bundle-env-check"));
    await cli.aart.store.workflows.put(workflow);
    await expect(
      cli.serverPort.produceBundle({ workflowId: workflow.id, workflowVersion: workflow.version, environment: "does-not-exist" }),
    ).rejects.toThrow(/environment "does-not-exist" not found/);
  });

  it("real ServerPort.startServer rejects an --environment name that doesn't exist (AMENDMENTS.md A45 — same name -> Deployment bridge as produceBundle above)", async () => {
    const root = await freshRoot();
    const cli = createCliContext({ root, trustMode: "governed" });
    await expect(cli.serverPort.startServer({ port: 0, environment: "does-not-exist" })).rejects.toThrow(/environment "does-not-exist" not found/);
  });

  it("real ServerPort.produceBundle succeeds with no --environment (bare closure bundle) and writes the real bundle layout", async () => {
    const root = await freshRoot();
    const cli = createCliContext({ root, trustMode: "governed" });
    const workflow = compileWorkflowInput(failingAssertWorkflow("wf-bundle-bare"));
    await cli.aart.store.workflows.put(workflow);
    const bundle = await cli.serverPort.produceBundle({ workflowId: workflow.id, workflowVersion: workflow.version });
    expect(bundle.files["manifest.json"]).toBeDefined();
    expect(bundle.files["triggers.json"]).toBeDefined();
    expect(bundle.files[`definitions/${workflow.id}@${workflow.version}.json`]).toBeDefined();
  });
});
