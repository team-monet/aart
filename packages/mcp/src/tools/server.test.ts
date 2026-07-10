// Mode-gating + progressive-disclosure tests — architecture §7.2/§10.1.
//
// DoD (load-bearing): "aart_approve's mode-gated absence in strict/
// production tested by asserting the tool-list returned to an MCP client
// genuinely omits it in those modes, not just that calling it fails." Every
// test in the first describe block below asserts against `listTools()`'s
// actual returned array — never merely that `callTool("aart_approve", ...)`
// errors.
import { afterEach, describe, expect, it } from "vitest";
import type { TrustMode } from "@aart/types";
import type { TestContext } from "../test-utils.js";
import { createTestContext, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "../handlers/authoring.js";
import { TOOL_NAMES } from "../response.js";
import { createMcpServer, isToolRegistered, listRegisteredTools } from "./server.js";

let tc: TestContext;
afterEach(async () => {
  await tc?.cleanup();
});

async function toolNames(trustMode: TrustMode): Promise<string[]> {
  tc = await createTestContext({ trustMode });
  const defs = await listRegisteredTools(tc.ctx);
  return defs.map((d) => d.name);
}

describe("aart_approve tool-list genuine absence (architecture §7.2's [DECISION], spec §17.5)", () => {
  it("dev mode: aart_approve IS present in the tool list", async () => {
    expect(await toolNames("dev")).toContain("aart_approve");
  });

  it("governed mode: aart_approve IS present in the tool list", async () => {
    expect(await toolNames("governed")).toContain("aart_approve");
  });

  it("strict mode: aart_approve is genuinely ABSENT from the tool list (not merely erroring when called)", async () => {
    const names = await toolNames("strict");
    expect(names).not.toContain("aart_approve");
  });

  it("production mode: aart_approve is genuinely ABSENT from the tool list", async () => {
    const names = await toolNames("production");
    expect(names).not.toContain("aart_approve");
  });

  it("isToolRegistered agrees with listTools for every mode (single source of truth)", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      tc = await createTestContext({ trustMode: mode });
      const viaList = (await listRegisteredTools(tc.ctx)).some((d) => d.name === "aart_approve");
      const viaCheck = await isToolRegistered(tc.ctx, "aart_approve");
      expect(viaCheck).toBe(viaList);
    }
  });

  it("in strict mode, callTool also refuses aart_approve (belt-and-suspenders, but listTools is the load-bearing check)", async () => {
    tc = await createTestContext({ trustMode: "strict" });
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_approve", { taskId: "x", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
  });
});

describe("core tools — always registered regardless of mode (architecture §32.2d: 9 of the 10 core tools are unconditional)", () => {
  const CORE_MINUS_APPROVE = TOOL_NAMES.filter((n) => n !== "aart_approve" && !["aart_list_blocks", "aart_get_schema", "aart_propose_workflow", "aart_diff_workflow", "aart_create_eval_from_correction", "aart_run_eval", "aart_promote_workflow", "aart_deploy_workflow", "aart_trigger_workflow", "aart_list_waiting_runs", "aart_resume_run"].includes(n));

  it("all 9 non-gated core tools are present in every trust mode", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      const names = await toolNames(mode);
      for (const tool of CORE_MINUS_APPROVE) expect(names).toContain(tool);
    }
  });
});

describe("progressive disclosure — the 5 named extended tools gate on real data existing (architecture §10.1's [DECISION])", () => {
  it("aart_deploy_workflow / aart_trigger_workflow are absent with zero Environment records", async () => {
    tc = await createTestContext();
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).not.toContain("aart_deploy_workflow");
    expect(names).not.toContain("aart_trigger_workflow");
  });

  it("aart_deploy_workflow / aart_trigger_workflow appear once an Environment exists", async () => {
    tc = await createTestContext();
    await tc.ctx.store.environments.put({ id: "env1", name: "staging", config: {} });
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).toContain("aart_deploy_workflow");
    expect(names).toContain("aart_trigger_workflow");
  });

  it("aart_create_eval_from_correction / aart_run_eval / aart_promote_workflow are absent with zero EvalSuites", async () => {
    tc = await createTestContext();
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).not.toContain("aart_create_eval_from_correction");
    expect(names).not.toContain("aart_run_eval");
    expect(names).not.toContain("aart_promote_workflow");
  });

  it("those 3 tools appear once an EvalSuite exists", async () => {
    tc = await createTestContext();
    await tc.ctx.store.evals.putSuite({ id: "s1", name: "S1", examples: [], scorer: { id: "sc", kind: "exact_match" }, tags: [] });
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).toContain("aart_create_eval_from_correction");
    expect(names).toContain("aart_run_eval");
    expect(names).toContain("aart_promote_workflow");
  });

  it("the other 6 extended tools have no data-existence precondition — always present", async () => {
    tc = await createTestContext();
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    for (const tool of ["aart_list_blocks", "aart_get_schema", "aart_propose_workflow", "aart_diff_workflow", "aart_list_waiting_runs", "aart_resume_run"]) {
      expect(names).toContain(tool);
    }
  });

  it("core loop stays at or under 10 tools even before any progressive-disclosure precondition is met (spec §32.2d)", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    const defs = await listRegisteredTools(tc.ctx);
    const core = defs.filter((d) => d.tier === "core");
    expect(core.length).toBeLessThanOrEqual(10);
  });
});

describe("createMcpServer — dispatch, envelope, and validation", () => {
  it("callTool on a registered tool returns a wrapped result with `next`", async () => {
    tc = await createTestContext();
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_find_blocks", { query: "goto" });
    expect(result.ok).toBe(true);
    expect(typeof result.next).toBe("string");
  });

  it("callTool on an unknown tool name fails gracefully", async () => {
    tc = await createTestContext();
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_totally_made_up", {});
    expect(result.ok).toBe(false);
  });

  it("callTool on a not-currently-registered extended tool fails gracefully, without throwing", async () => {
    tc = await createTestContext();
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_promote_workflow", { workflowId: "x", workflowVersion: "1" });
    expect(result.ok).toBe(false);
  });

  it("callTool validates arguments against the tool's Zod input schema", async () => {
    tc = await createTestContext();
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_get_block", {}); // missing required `id`
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid arguments/);
  });

  it("end-to-end: register -> validate -> run -> get_report all dispatch correctly through the server", async () => {
    tc = await createTestContext();
    const server = createMcpServer(tc.ctx);
    const registered = await server.callTool("aart_register_block", { workflow: sampleWorkflowYaml("wf-server-e2e") });
    expect(registered.ok).toBe(true);
    expect(registered.next).toContain("aart_validate");

    const validated = await server.callTool("aart_validate", { workflowId: "wf-server-e2e", workflowVersion: "0.1.0" });
    expect(validated.ok).toBe(true);

    const ran = await server.callTool("aart_run_workflow", { workflowId: "wf-server-e2e", input: { url: "https://example.com" } });
    expect(ran.ok).toBe(true);

    const report = await server.callTool("aart_get_report", { runId: ran.runId });
    expect(report.ok).toBe(true);
  });
});

describe("registerWorkflowHandler cross-check (sanity: handlers module used by these tests works standalone too)", () => {
  it("registers without going through the server", async () => {
    tc = await createTestContext();
    const result = await registerWorkflowHandler(tc.ctx, { workflow: sampleWorkflowYaml("wf-direct") });
    expect(result.ok).toBe(true);
  });
});
