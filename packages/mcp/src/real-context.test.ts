// Proves createRealAartContext genuinely wires the real @aart/engine/
// @aart/governance/@aart/evidence/@aart/registry packages end-to-end - not
// just that it type-checks (S9 integration, reconciliation ledger items
// 3/4/5/11). Deliberately uses only fast/offline/deterministic blocks
// (flow.noop, data.map) - no browser/LLM blocks - so this suite stays fast
// and doesn't require network/API keys, matching this package's own
// existing test-suite hygiene (see context.ts's own doc comment on why
// createAartContext's DEFAULT stays stub-bound).
import { afterEach, describe, expect, it } from "vitest";
import { approveInstalledPack, persistInstalledPack } from "@aart/registry";
import type { BlockImplementation, Workflow } from "@aart/types";
import { createRealAartContext, createRealAartContextWithEngine, type AartContext } from "./context.js";
import { buildRealCatalog, createRealEngine } from "./real-context.js";
import { makeTempRoot, cleanupTempRoot } from "./test-utils.js";
import { runWorkflowHandler } from "./handlers/execution.js";

let root: string | undefined;
let ctx: AartContext | undefined;
afterEach(async () => {
  if (root) await cleanupTempRoot(root);
  root = undefined;
  ctx = undefined;
});

async function setup(): Promise<AartContext> {
  root = await makeTempRoot("aart-mcp-real-");
  ctx = createRealAartContext({ root });
  return ctx;
}

function noopWorkflow(id: string): Workflow {
  return {
    id,
    name: "Real context smoke test workflow",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.noop", with: { value: { hello: "world" } } }] },
    approval: "approved",
    gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
  };
}

describe("buildRealCatalog", () => {
  it("assembles the real 56-block catalog (51 @aart/blocks-core + 5 @aart/llm), not the 24-manifest placeholder it replaces", async () => {
    const { createFsStore } = await import("@aart/store");
    const tmpRoot = await makeTempRoot("aart-mcp-catalog-");
    try {
      const store = createFsStore(tmpRoot);
      const { blocks, entries } = buildRealCatalog(store);
      expect(Object.keys(blocks)).toHaveLength(56);
      expect(entries).toHaveLength(56);
      // Spot-check a block from each package landed in this catalog.
      expect(blocks["browser.click"]).toBeDefined();
      expect(blocks["flow.noop"]).toBeDefined();
      expect(blocks["llm.extract"]).toBeDefined();
      expect(blocks["llm.judge"]).toBeDefined();
    } finally {
      await cleanupTempRoot(tmpRoot);
    }
  });
});

describe("createRealAartContext — Pack catalog refresh", () => {
  it("can execute a Pack installed after the long-running context was constructed", async () => {
    ctx = await setup();
    const installed = await persistInstalledPack(
      root!,
      {
        manifestYaml: "name: hotpack\nversion: 1.0.0\nblocks: [hotpack.echo]\n",
        blockSources: {
          "hotpack.echo": `module.exports = {
            manifest: {
              id: "hotpack.echo",
              version: "1.0.0",
              capabilities: [],
              inputSchema: {},
              outputSchema: {},
              description: "Hot-loaded Pack block"
            },
            execute: (input) => ({ value: input.value })
          };`,
        },
      },
      { kind: "workspace", source: "bundle-test" },
    );
    await approveInstalledPack(
      root!,
      "hotpack",
      "1.0.0",
      "bundle-test",
      new Date("2026-07-27T00:00:00.000Z"),
      installed.manifest.contentHash,
    );
    await ctx.store.packManifests.put({ ...installed.manifest, approvalStatus: "approved" });
    await ctx.store.workflows.put({
      id: "hot-pack-workflow",
      name: "Hot Pack Workflow",
      version: "1.0.0",
      inputs: [{ name: "value", type: "string", required: true }],
      outputs: [],
      execution: {
        type: "workflow",
        steps: [{ id: "echo", uses: "hotpack.echo", with: { value: "{{ inputs.value }}" } }],
      },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });

    const result = await runWorkflowHandler(ctx, {
      workflowId: "hot-pack-workflow",
      workflowVersion: "1.0.0",
      input: { value: "hello" },
    });
    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(typeof result.runId).toBe("string");
    const run = await ctx.store.runs.get(result.runId as string);
    expect(run?.snapshot.packHashes).toEqual({ hotpack: installed.manifest.contentHash });
  });
});

describe("createRealEngine — Pack version pinning", () => {
  it("resumes a waiting run with the Pack implementation captured in its snapshot", async () => {
    root = await makeTempRoot("aart-mcp-pack-snapshot-");
    const { createFsStore } = await import("@aart/store");
    const store = createFsStore(root);
    const coreBlocks = buildRealCatalog(store).blocks;
    const packBlock = (version: string): BlockImplementation => ({
      manifest: {
        id: "demo.echo",
        version,
        capabilities: [],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        description: `Demo Pack ${version}`,
      },
      execute: async () => ({ version }),
    });
    const v1 = packBlock("1.0.0");
    const v2 = packBlock("2.0.0");
    const v1Hash = "sha256:v1";
    const v2Hash = "sha256:v2";
    const workflow: Workflow = {
      id: "pack-snapshot-resume",
      name: "Pack snapshot resume",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: {
        type: "workflow",
        steps: [
          { id: "review", uses: "wait.manual" },
          { id: "pack_step", uses: "demo.echo" },
        ],
      },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await store.workflows.put(workflow);

    const firstProcess = createRealEngine(
      store,
      { ...coreBlocks, "demo.echo": v1 },
      "dev",
      async () => ({ demo: v1Hash }),
      new Map([[v1Hash, { "demo.echo": v1 }]]),
    );
    const created = await firstProcess.triggerRun({
      workflow,
      trigger: { id: "pack-v1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
    });
    const waiting = await firstProcess.executeRun(created.runId);
    expect(waiting.status).toBe("waiting");
    expect(waiting.snapshot.packHashes).toEqual({ demo: v1Hash });

    const restartedProcess = createRealEngine(
      store,
      { ...coreBlocks, "demo.echo": v2 },
      "dev",
      async () => ({ demo: v2Hash }),
      new Map([
        [v1Hash, { "demo.echo": v1 }],
        [v2Hash, { "demo.echo": v2 }],
      ]),
    );
    const resumed = await restartedProcess.resumeManual(created.runId, "review", { reviewer: "operator" });
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") throw new Error("expected the waiting run to resume");
    expect(resumed.run.status).toBe("completed");
    expect(resumed.run.trace.find((step) => step.stepId === "pack_step")?.outputs).toEqual({ version: "1.0.0" });
  });

  it("fails closed when a snapshotted Pack seal disappears instead of falling back to a same-id core block", async () => {
    root = await makeTempRoot("aart-mcp-pack-missing-snapshot-");
    const { createFsStore } = await import("@aart/store");
    const store = createFsStore(root);
    const coreBlocks = buildRealCatalog(store).blocks;
    const packBlock: BlockImplementation = {
      manifest: {
        id: "demo.echo",
        version: "1.0.0",
        capabilities: [],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        description: "Pack implementation",
      },
      execute: async () => ({ source: "pack" }),
    };
    const coreReplacement: BlockImplementation = {
      ...packBlock,
      manifest: { ...packBlock.manifest, version: "9.0.0", description: "Core replacement" },
      execute: async () => ({ source: "core" }),
    };
    const workflow: Workflow = {
      id: "missing-pack-snapshot",
      name: "Missing Pack snapshot",
      version: "1.0.0",
      inputs: [],
      outputs: [],
      execution: {
        type: "workflow",
        steps: [
          { id: "review", uses: "wait.manual" },
          { id: "pack_step", uses: "demo.echo" },
        ],
      },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await store.workflows.put(workflow);
    const v1Hash = "sha256:missing-v1";
    const firstProcess = createRealEngine(
      store,
      { ...coreBlocks, "demo.echo": packBlock },
      "dev",
      async () => ({ demo: v1Hash }),
      new Map([[v1Hash, { "demo.echo": packBlock }]]),
    );
    const created = await firstProcess.triggerRun({
      workflow,
      trigger: { id: "missing-pack", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
    });
    expect((await firstProcess.executeRun(created.runId)).status).toBe("waiting");

    const restartedProcess = createRealEngine(
      store,
      { ...coreBlocks, "demo.echo": coreReplacement },
      "dev",
      async () => ({}),
      new Map(),
    );
    const resumed = await restartedProcess.resumeManual(created.runId, "review", { reviewer: "operator" });
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") throw new Error("expected the waiting run to resume");
    expect(resumed.run.status).toBe("failed");
    expect(resumed.run.error).toMatch(/snapshotted implementation is unavailable/);
    expect(resumed.run.trace.find((step) => step.stepId === "pack_step")?.outputs).not.toEqual({ source: "core" });
  });
});

describe("createRealAartContext — end-to-end against the real engine (not StubEngine's simulated semantics)", () => {
  it("triggers and executes a real workflow through the real @aart/engine dispatch loop", async () => {
    const c = await setup();
    const workflow = noopWorkflow("real-ctx-e2e-1");
    await c.store.workflows.put(workflow);

    const run = await c.engine.triggerRun({
      workflow,
      trigger: { id: "trig-1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() },
      inputs: {},
    });
    expect(run.status).toBe("pending");

    const finished = await c.engine.executeRun(run.runId);
    expect(finished.status).toBe("completed");
    // The REAL flow.noop block actually ran (not a stub's empty-outputs
    // simulation) - its real execute() echoes `value` back verbatim.
    expect(finished.trace[0]?.outputs).toEqual({ value: { hello: "world" } });
    expect(finished.trace[0]?.block).toBe("flow.noop");
  });

  it("redaction genuinely runs end-to-end: a resolved secret never reaches the persisted RunRecord", async () => {
    root = await makeTempRoot("aart-mcp-real-redact-");
    const { createFsStore } = await import("@aart/store");
    const store = createFsStore(root);
    // Inject a resolveSecret so the real engine actually has a secret to
    // resolve+redact - createRealAartContext's own engine has no secret
    // resolver wired by default (no test/dev secret adapter exists yet),
    // so this test builds the real engine directly via real-context.ts's
    // own exports rather than going through createRealAartContext, to
    // exercise the SAME real redactRecord chokepoint with a concrete
    // secret value.
    const { buildRealCatalog: buildCatalog, createRealEngine } = await import("./real-context.js");
    const { blocks } = buildCatalog(store);
    const { createEngine } = await import("@aart/engine");
    const { redactRecord } = await import("@aart/governance");
    const engine = createEngine({
      store,
      redact: redactRecord,
      capabilityCheck: () => true,
      blocks,
      resolveSecret: async () => "super-secret-value",
    });

    const workflow: Workflow = {
      id: "real-ctx-redact-1",
      name: "Redaction smoke test",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.noop", with: { value: "{{ secrets.API_KEY }}" } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await store.workflows.put(workflow);
    const run = await engine.triggerRun({ workflow, trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() }, inputs: {} });
    await engine.executeRun(run.runId);

    const persisted = await store.runs.get(run.runId);
    const json = JSON.stringify(persisted);
    expect(json).not.toContain("super-secret-value");
    expect(json).toContain("REDACTED");
  });
});

describe("createRealAartContext — real governance validation (distinct from the stub's schema-only check)", () => {
  it("a workflow with a bad/unknown block reference gets a REAL reference-validation finding (validation class 2), not just a schema pass", async () => {
    const c = await setup();
    const badWorkflow: Workflow = {
      id: "real-ctx-validate-1",
      name: "Bad reference",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "totally.not.a.real.block" }] },
      approval: "draft",
      gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    };
    const result = c.governance.validateWorkflow(badWorkflow);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.class === "reference")).toBe(true);
  });
});

describe("createRealAartContext — real registry search", () => {
  it("finds a real block by id, with real search ranking (not the 24-block placeholder's fixed set)", async () => {
    const c = await setup();
    const results = c.registry.findBlocks({ query: "browser.click" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.entry.manifest.id).toBe("browser.click");
  });
});

describe("createRealAartContext — options.llm passthrough (real llm.extract dispatch with a faked provider client, no real API key needed)", () => {
  it("runs the REAL llm.extract block end-to-end (schema validation, retry wrapper, output-schema enforcement) via an injected fake Anthropic client", async () => {
    const root = await makeTempRoot("aart-mcp-real-llm-");
    try {
      const { createFsStore } = await import("@aart/store");
      const store = createFsStore(root);
      let seenPrompt: string | undefined;
      const c = createRealAartContext({
        store,
        llm: {
          anthropic: {
            client: {
              messages: {
                create: async (params) => {
                  seenPrompt = (params["messages"] as Array<{ content: string }>)[0]?.content;
                  return { content: [{ type: "text", text: JSON.stringify({ total: 42 }) }], usage: { input_tokens: 10, output_tokens: 5 } };
                },
              },
            },
          },
        },
      });

      const workflow: Workflow = {
        id: "real-ctx-llm-1",
        name: "Real llm.extract smoke test",
        version: "0.1.0",
        inputs: [],
        outputs: [],
        execution: {
          type: "workflow",
          steps: [
            {
              id: "extract",
              uses: "llm.extract",
              with: { model: "anthropic/claude-sonnet-5", prompt: "Extract the total from this bill.", input: "Total due: $42.00", outputSchema: { type: "object", properties: { total: { type: "number" } }, required: ["total"] } },
            },
          ],
        },
        approval: "approved",
        gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
      };
      await store.workflows.put(workflow);
      const run = await c.engine.triggerRun({ workflow, trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() }, inputs: {} });
      const finished = await c.engine.executeRun(run.runId);

      expect(finished.status).toBe("completed");
      expect(finished.trace[0]?.outputs).toEqual({ total: 42 });
      // Proves this genuinely went through llm.extract's real dispatch (not
      // a hand-rolled fixture standing in for the whole block) - the fake
      // client received the REAL prompt text this block's own real
      // buildUserContent logic constructed.
      expect(seenPrompt).toContain("Extract the total from this bill.");
    } finally {
      await cleanupTempRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// AMENDMENTS.md (S15) — settling the S11/A42 governance-permissiveness
// finding: "an UNAPPROVED workflow with Medium-risk capabilities ran to
// completion in `governed` trust mode." Root cause (see real-context.ts's
// own doc comment on createGetGrantedCapabilities): the capability-dispatch
// chokepoint's trust-mode resolution silently hardcoded "dev" (unconditional
// grant) whenever a run carried no `environment` — which is EVERY
// `aart run`/`aart_run_workflow` call, since RunWorkflowInput has no
// `environment` field at all. This pins the settled per-mode semantics for
// both entry points that share runWorkflowHandler (CLI `aart run` and MCP
// `aart_run_workflow` dispatch through the literal same function, per
// context.ts's own module comment on the three-clients principle).
// ---------------------------------------------------------------------------
function draftArtifactWorkflow(id: string): Workflow {
  // Mirrors the EXACT S11/A42 repro: a Medium-risk capability (`file.write`
  // via `artifact.write`, spec §31.1) on an unapproved draft version, no
  // browser/LLM involved so this stays fast/offline/deterministic.
  return {
    id,
    name: "Draft workflow with a Medium-risk capability (file.write via artifact.write)",
    version: "0.1.0",
    inputs: [],
    outputs: [],
    execution: { type: "workflow", steps: [{ id: "s1", uses: "artifact.write", with: { name: "out.txt", kind: "file", mime: "text/plain", content: "hello" } }] },
    approval: "draft",
    gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
  };
}

describe("runWorkflowHandler (aart run / aart_run_workflow) — real capability-dispatch gating per trust mode, no --environment attached", () => {
  it("governed mode (spec §17.2's own 'Local development default') DENIES an unapproved draft's capability-bearing step — the exact S11/A42 regression: omitting --environment must not silently grant everything", async () => {
    root = await makeTempRoot("aart-mcp-real-governed-deny-");
    ctx = createRealAartContext({ root, trustMode: "governed" });
    const workflow = draftArtifactWorkflow("real-ctx-governed-deny-1");
    await ctx.store.workflows.put(workflow);

    const result = await runWorkflowHandler(ctx, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(String(result.error)).toMatch(/not a subset of this run's granted capabilities/);

    const persisted = await ctx.store.runs.get(result.runId as string);
    expect(persisted?.trace[0]).toMatchObject({ status: "failed", block: "artifact.write" });
  });

  it("strict and production modes ALSO deny the same unapproved draft — the fix is trust-mode-general (every non-dev mode fails closed), not governed-specific", async () => {
    for (const trustMode of ["strict", "production"] as const) {
      root = await makeTempRoot(`aart-mcp-real-${trustMode}-deny-`);
      ctx = createRealAartContext({ root, trustMode });
      const workflow = draftArtifactWorkflow(`real-ctx-${trustMode}-deny-1`);
      await ctx.store.workflows.put(workflow);

      const result = await runWorkflowHandler(ctx, { workflowId: workflow.id, workflowVersion: workflow.version });
      expect(result.ok).toBe(false);
      expect(result.status).toBe("failed");
      await cleanupTempRoot(root);
    }
    root = undefined;
  });

  it("dev mode (spec §17.2's documented 'Experimental override: dev' escape hatch) still runs the SAME unapproved draft to completion — authoring-loop freedom is preserved, but only when explicitly opted into, never as a side effect of omitting --environment", async () => {
    root = await makeTempRoot("aart-mcp-real-dev-allow-");
    ctx = createRealAartContext({ root, trustMode: "dev" });
    const workflow = draftArtifactWorkflow("real-ctx-dev-allow-1");
    await ctx.store.workflows.put(workflow);

    const result = await runWorkflowHandler(ctx, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("governed mode runs an ALREADY-APPROVED version's identical capability-bearing step to completion — approval (via aart_approve/aart approve), not trust-mode alone, is what unlocks it", async () => {
    root = await makeTempRoot("aart-mcp-real-governed-approved-");
    ctx = createRealAartContext({ root, trustMode: "governed" });
    const workflow: Workflow = {
      ...draftArtifactWorkflow("real-ctx-governed-approved-1"),
      approval: "approved",
      gates: { validate: "passed", readiness: "pending", evals: "waived", riskReview: "waived", humanReview: "passed" },
    };
    await ctx.store.workflows.put(workflow);

    const result = await runWorkflowHandler(ctx, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
  });

  it("a workflow using ONLY zero-capability blocks runs fine in governed mode even as an unapproved draft — the authoring loop is never blocked for capability-free iteration (declared ⊆ granted is vacuously true for an empty declared set)", async () => {
    root = await makeTempRoot("aart-mcp-real-governed-nocap-");
    ctx = createRealAartContext({ root, trustMode: "governed" });
    const workflow: Workflow = {
      id: "real-ctx-governed-nocap-1",
      name: "Draft workflow with no capability-bearing steps",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.noop", with: { value: 1 } }] },
      approval: "draft",
      gates: { validate: "pending", readiness: "pending", evals: "pending", riskReview: "pending", humanReview: "pending" },
    };
    await ctx.store.workflows.put(workflow);

    const result = await runWorkflowHandler(ctx, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — createRealAartContext's
// bundler/remotes ports genuinely wired end to end, not just type-checked
// (same S9-integration discipline this whole file exists for).
describe("createRealAartContext — ctx.bundler / ctx.remotes (AMENDMENTS.md A56)", () => {
  it("ctx.bundler.produceBundle calls the REAL @aart/server produceBundle (full transitive closure), not a stub single-workflow bundle", async () => {
    ctx = await setup();
    await ctx.store.workflows.put({
      id: "real-ctx-bundle-child",
      name: "child",
      version: "1",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });
    await ctx.store.workflows.put({
      id: "real-ctx-bundle-root",
      name: "root",
      version: "1",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "nested", uses: "flow.subworkflow", with: { workflowId: "real-ctx-bundle-child", version: "1" } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });

    const bundle = await ctx.bundler.produceBundle({ workflowId: "real-ctx-bundle-root", workflowVersion: "1" });
    // The REAL produceBundle walks the closure -- both root AND child land
    // under definitions/; the stub bundler only ever writes the ONE
    // requested workflow (stubs/deploy.ts's own documented simplification).
    expect(bundle.files["definitions/real-ctx-bundle-root@1.json"]).toBeDefined();
    expect(bundle.files["definitions/real-ctx-bundle-child@1.json"]).toBeDefined();
    expect((bundle.manifest as { bundleHash: string }).bundleHash).toMatch(/^[0-9a-f]{64}$/); // a real sha256 content hash, not the stub's absence of one
  });

  it("ctx.bundler.produceBundle threads --environment into manifest.targetEnvironment and throws for an unregistered one", async () => {
    ctx = await setup();
    await ctx.store.workflows.put({
      id: "real-ctx-bundle-env",
      name: "n",
      version: "1",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    });
    await ctx.store.environments.put({ id: "env_real_ctx", name: "staging", config: {} });

    const bundle = await ctx.bundler.produceBundle({ workflowId: "real-ctx-bundle-env", workflowVersion: "1", environment: "staging" });
    expect((bundle.manifest as { targetEnvironment?: string }).targetEnvironment).toBe("staging");

    await expect(ctx.bundler.produceBundle({ workflowId: "real-ctx-bundle-env", workflowVersion: "1", environment: "no-such-env" })).rejects.toThrow(/not found/i);
  });

  // D1 fix pass (AMENDMENTS.md A57, tester finding) — resolveDeploymentForEnvironmentName
  // checks the CALLER's OWN store (by design: the caller's local Deployment
  // for that environment carries the triggerConfig a bundle ships with),
  // which confused first-time users who only ever registered the
  // environment on a REMOTE server. The remedy now names the local CLI
  // registration command AND explicitly distinguishes it from server-side
  // registration, rather than a bare "not found."
  it("an unregistered environment's error names the local registration command AND distinguishes it from server-side registration", async () => {
    ctx = await setup();
    let message = "";
    try {
      await ctx.bundler.produceBundle({ workflowId: "real-ctx-bundle-env-remedy", workflowVersion: "1", environment: "production" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/not found on THIS store/i); // fact 1: this is a check against the CALLER's own store
    expect(message).toContain('aart environment register production --trust-mode'); // the exact local remedy command, naming the actual environment
    expect(message).toMatch(/POST \/environments/); // the HTTP form of the SAME local remedy
    expect(message).toMatch(/separately from.*REMOTE server|REMOTE server.*separately from/is); // fact 2: explicitly distinguished from server-side registration
  });

  it("ctx.remotes reads real remotes.json/secrets.json from the same root this context is rooted at", async () => {
    ctx = await setup();
    const { promises: fs } = await import("node:fs");
    const { join } = await import("node:path");
    await fs.writeFile(join(root!, "remotes.json"), JSON.stringify({ production: { url: "https://prod.example.com", environment: "production", tokenRef: "secrets.DEPLOY_TOKEN" } }), "utf8");
    await fs.writeFile(join(root!, "secrets.json"), JSON.stringify({ DEPLOY_TOKEN: "real-resolved-token" }), "utf8");

    await expect(ctx.remotes.get("production")).resolves.toEqual({ url: "https://prod.example.com", environment: "production", tokenRef: "secrets.DEPLOY_TOKEN" });
    await expect(ctx.remotes.resolveToken("production")).resolves.toBe("real-resolved-token");
  });
});

// ---------------------------------------------------------------------------
// V1 event log foundation (AMENDMENTS.md A61), RISK 1's MANDATORY TEST:
// run.completed/failed/cancelled emitted through each real entry point —
// mirroring the four-entry-point discipline A48 established.
//
// (1) CLI `aart run` + MCP `aart_run_workflow`: the SAME function
//     (runWorkflowHandler) dispatched through createRealAartContext, per
//     this file's own established "same function reference" precedent
//     (see the "runWorkflowHandler (aart run / aart_run_workflow)" describe
//     block above) — one test genuinely covers both entry points.
// (2) trigger-fired via server + worker-claimed: @aart/server's
//     createRealEngineBoundary wrapping the SAME createRealEngine this file
//     already tests — the exact composition `@aart/cli`'s real-server-port.ts
//     performs (createRealServerPort -> createRealEngineBoundary(store,
//     engine), cli-context.ts's own module comment) — proving the fix
//     reaches this entry point too, not just direct-run.
// (3) worker-reclaimed: a fully independent, non-engine code path
//     (packages/server/src/worker/reclaim.ts's runReclaimSweep) — covered
//     separately in packages/server/src/worker/worker.test.ts (that
//     package owns reclaim.ts; this file cannot reach it without a real
//     circular @aart/server<->@aart/mcp dependency).
// ---------------------------------------------------------------------------
describe("createRealEngine — onRunTerminal emits run.completed/failed/cancelled (V1 event log foundation, AMENDMENTS.md A61, RISK 1)", () => {
  it("a completed run emits run.completed — the entry point CLI `aart run` and MCP `aart_run_workflow` both dispatch through (runWorkflowHandler)", async () => {
    const c = await setup();
    const workflow = noopWorkflow("event-log-completed-1");
    await c.store.workflows.put(workflow);
    const result = await runWorkflowHandler(c, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.status).toBe("completed");

    const events = await c.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", workflowId: workflow.id, workflowVersion: workflow.version, runId: result.runId }));
  });

  it("a failed run (flow.fail) emits run.failed, not run.completed", async () => {
    const c = await setup();
    const workflow: Workflow = {
      id: "event-log-failed-1",
      name: "Real engine failure smoke test",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.fail", with: { message: "intentional failure for the event-log test" } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await c.store.workflows.put(workflow);
    const result = await runWorkflowHandler(c, { workflowId: workflow.id, workflowVersion: workflow.version });
    expect(result.status).toBe("failed");

    const events = await c.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.failed", workflowId: workflow.id, workflowVersion: workflow.version, runId: result.runId }));
    expect(events.some((e) => e.type === "run.completed" && e.runId === result.runId)).toBe(false);
  });

  it("an explicitly cancelled run emits run.cancelled — proves cancelRun shares the SAME onRunTerminal hook as finalizeTerminal, not a separate uninstrumented path", async () => {
    root = await makeTempRoot("aart-mcp-real-cancel-");
    const { createFsStore } = await import("@aart/store");
    const store = createFsStore(root);
    const { blocks } = buildRealCatalog(store);
    const { redactRecord } = await import("@aart/governance");
    // Built via THIS package's own real-context.ts createRealEngine (not a
    // hand-rolled createEngine call) — the actual production composition
    // root this session's fix landed in, not a re-implemented approximation
    // of it.
    const engine = createRealEngine(store, blocks, "governed");
    void redactRecord; // referenced only to confirm the real redactor module resolves in this test's own import graph

    const workflow: Workflow = {
      id: "event-log-cancelled-1",
      name: "Real engine cancellation smoke test",
      version: "0.1.0",
      inputs: [],
      outputs: [],
      execution: { type: "workflow", steps: [{ id: "s1", uses: "flow.noop", with: { value: 1 } }] },
      approval: "approved",
      gates: { validate: "passed", readiness: "passed", evals: "passed", riskReview: "passed", humanReview: "passed" },
    };
    await store.workflows.put(workflow);
    const created = await engine.triggerRun({ workflow, trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() }, inputs: {} });
    // Cancelled BEFORE executeRun ever runs it — still reaches finalizeTerminal's shared runOnRunTerminal path (run-lifecycle.ts's cancelRun, independent of the step-loop).
    const cancelled = await engine.cancelRun(created.runId);
    expect(cancelled.status).toBe("cancelled");

    const events = await store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.cancelled", workflowId: workflow.id, workflowVersion: workflow.version, runId: created.runId }));
  });
});

describe("trigger-fired via server + worker-claimed — EngineBoundary shares the SAME event-log wiring (V1 event log foundation, AMENDMENTS.md A61, RISK 1)", () => {
  it("a run started via EngineBoundary.startRun and finished via executeClaimedRun (the exact @aart/cli real-server-port.ts composition: createRealEngineBoundary(store, createRealEngine(...))) emits run.completed", async () => {
    root = await makeTempRoot("aart-mcp-real-boundary-");
    const { createFsStore } = await import("@aart/store");
    const { createRealEngineBoundary } = await import("@aart/server");
    const store = createFsStore(root);
    const { blocks } = buildRealCatalog(store);
    const engine = createRealEngine(store, blocks, "governed");
    const boundary = createRealEngineBoundary(store, engine);

    const workflow = noopWorkflow("event-log-boundary-1");
    await store.workflows.put(workflow);

    const started = await boundary.startRun({
      workflowId: workflow.id,
      trigger: { id: "t1", type: "webhook", source: "test", payload: null, receivedAt: new Date().toISOString() },
      mappedInputs: {},
    });
    expect(started.kind).toBe("started");
    const runId = (started as { runId: string }).runId;

    // executeClaimedRun — "used by the worker claim loop... once admission
    // control + the race-safe job_queue claim has already won the claim,"
    // EngineBoundary's own doc comment (packages/server/src/engine/
    // boundary.ts) — this is the worker-claimed half of this entry point.
    await boundary.executeClaimedRun(runId, "worker-1");

    const finished = await store.runs.get(runId);
    expect(finished?.status).toBe("completed");

    const events = await store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", workflowId: workflow.id, workflowVersion: workflow.version, runId }));
  });
});

// Re-confirms createRealAartContextWithEngine (cli-context.ts's own
// dependency, real-server-port.ts's engine source) is genuinely the SAME
// createRealEngine instrumented above — not a second, divergent
// construction this test suite's own direct createRealEngine calls could
// miss.
describe("createRealAartContextWithEngine — the raw Engine it hands back is the SAME instrumented createRealEngine (RISK 1 coverage sanity check)", () => {
  it("a run executed via the returned raw Engine also emits run.completed", async () => {
    root = await makeTempRoot("aart-mcp-real-withengine-");
    const { context, engine } = createRealAartContextWithEngine({ root });
    expect(engine).toBeDefined();
    const workflow = noopWorkflow("event-log-withengine-1");
    await context.store.workflows.put(workflow);
    const created = await engine!.triggerRun({ workflow, trigger: { id: "t1", type: "manual", source: "test", payload: null, receivedAt: new Date().toISOString() }, inputs: {} });
    await engine!.executeRun(created.runId);
    const events = await context.store.events.list();
    expect(events).toContainEqual(expect.objectContaining({ type: "run.completed", runId: created.runId }));
  });
});
