// Proves createRealAartContext genuinely wires the real @aart/engine/
// @aart/governance/@aart/evidence/@aart/registry packages end-to-end - not
// just that it type-checks (S9 integration, reconciliation ledger items
// 3/4/5/11). Deliberately uses only fast/offline/deterministic blocks
// (flow.noop, data.map) - no browser/LLM blocks - so this suite stays fast
// and doesn't require network/API keys, matching this package's own
// existing test-suite hygiene (see context.ts's own doc comment on why
// createAartContext's DEFAULT stays stub-bound).
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@aart/types";
import { createRealAartContext, type AartContext } from "./context.js";
import { buildRealCatalog } from "./real-context.js";
import { makeTempRoot, cleanupTempRoot } from "./test-utils.js";

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
