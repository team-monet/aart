// Mode-gating + progressive-disclosure tests — architecture §7.2/§10.1.
//
// DoD (load-bearing): "aart_approve's mode-gated absence in strict/
// production tested by asserting the tool-list returned to an MCP client
// genuinely omits it in those modes, not just that calling it fails." Every
// test in the first describe block below asserts against `listTools()`'s
// actual returned array — never merely that `callTool("aart_approve", ...)`
// errors.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustMode } from "@aart/types";
import type { TestContext } from "../test-utils.js";
import { createTestContext, sampleWorkflowYaml } from "../test-utils.js";
import { registerWorkflowHandler } from "../handlers/authoring.js";
import { TOOL_NAMES, TOOL_TIERS } from "../response.js";
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

/** Configures one throwaway remote (unreachable URL — these tests only ever check registration/gating, never make a real network call) — shared by the `aart_remote_*` read-tools describe block and Wave 2C's `aart_remote_approve` describe block below (hoisted to module scope, formerly local to the read-tools block alone, so both can use it without a divergent second copy). */
async function writeRemote(root: string): Promise<void> {
  await fs.writeFile(join(root, "remotes.json"), JSON.stringify({ staging: { url: "http://localhost:1", environment: "staging" } }), "utf8");
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

describe("core tools — discovery/execution tools are unconditional; human decision tools are mode-gated", () => {
  const CORE_MINUS_APPROVE = TOOL_NAMES.filter(
    (n) => TOOL_TIERS[n] === "core" && n !== "aart_approve" && n !== "aart_approve_pack",
  );

  it("all non-gated core tools are present in every trust mode", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      const names = await toolNames(mode);
      for (const tool of CORE_MINUS_APPROVE) expect(names).toContain(tool);
    }
  });
});

// D1 "remotes + push" (AMENDMENTS.md A56) — "registers unconditionally, all
// trust modes; server-side enforcement is the chokepoint" (the ratified
// design memo's own words): dev/governed/strict/production must ALL see
// aart_deploy in listTools(), with no Environment/EvalSuite precondition
// either (unlike aart_deploy_workflow/aart_trigger_workflow just above).
describe("aart_deploy — registers unconditionally in every trust mode (AMENDMENTS.md A56)", () => {
  it("dev/governed/strict/production: aart_deploy is present in the tool list", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      const names = await toolNames(mode);
      expect(names, `trust mode ${mode}`).toContain("aart_deploy");
    }
  });

  it("present with ZERO Environment records and ZERO EvalSuites — no progressive-disclosure precondition, unlike aart_deploy_workflow", async () => {
    tc = await createTestContext();
    await expect(tc.ctx.store.environments.list()).resolves.toEqual([]);
    await expect(tc.ctx.store.evals.listSuites()).resolves.toEqual([]);
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).toContain("aart_deploy");
  });

  it("isToolRegistered agrees with listTools for every mode (single source of truth)", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      tc = await createTestContext({ trustMode: mode });
      const viaList = (await listRegisteredTools(tc.ctx)).some((d) => d.name === "aart_deploy");
      const viaCheck = await isToolRegistered(tc.ctx, "aart_deploy");
      expect(viaCheck).toBe(true);
      expect(viaCheck).toBe(viaList);
    }
  });
});

describe("progressive disclosure — environment/eval extended tools gate on real data existing", () => {
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

  it("the other 7 extended tools (6 original + D1's aart_deploy, AMENDMENTS.md A56) have no data-existence precondition — always present", async () => {
    tc = await createTestContext();
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    for (const tool of ["aart_list_blocks", "aart_get_schema", "aart_propose_workflow", "aart_diff_workflow", "aart_list_waiting_runs", "aart_resume_run", "aart_deploy"]) {
      expect(names).toContain(tool);
    }
  });

  it("core loop includes reuse-first workflow and public Pack discovery/install/approval", async () => {
    tc = await createTestContext({ trustMode: "governed" });
    const defs = await listRegisteredTools(tc.ctx);
    const core = defs.filter((d) => d.tier === "core");
    expect(core.map((d) => d.name)).toContain("aart_find_workflows");
    expect(core.map((d) => d.name)).toContain("aart_find_packs");
    expect(core).toHaveLength(14);
  });
});

describe("aart_approve_pack uses the same human-approval mode gate as aart_approve", () => {
  it("is present in dev/governed and absent in strict/production", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      const names = await toolNames(mode);
      expect(names.includes("aart_approve_pack")).toBe(mode === "dev" || mode === "governed");
    }
  });
});

// D2b "remote reads" (AMENDMENTS.md A62) — a THIRD progressive-disclosure
// precondition (REMOTE_GATED_TOOLS, tools/server.ts), the same shape as the
// Environment/EvalSuite gates above but keyed on ctx.remotes.list() instead
// of a store collection.
describe("aart_remote_* tools — gated on >=1 configured remote existing (AMENDMENTS.md A62)", () => {
  const REMOTE_TOOLS = ["aart_remote_status", "aart_remote_why", "aart_remote_runs", "aart_remote_run"] as const;

  it("all four are absent with zero configured remotes", async () => {
    tc = await createTestContext();
    await expect(tc.ctx.remotes.list()).resolves.toEqual({});
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    for (const tool of REMOTE_TOOLS) expect(names).not.toContain(tool);
  });

  it("all four appear once >=1 remote is configured", async () => {
    tc = await createTestContext();
    await writeRemote(tc.root);
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    for (const tool of REMOTE_TOOLS) expect(names).toContain(tool);
  });

  it("isToolRegistered agrees with listTools for every one of the four, both with and without a configured remote", async () => {
    for (const withRemote of [false, true]) {
      tc = await createTestContext();
      if (withRemote) await writeRemote(tc.root);
      for (const tool of REMOTE_TOOLS) {
        const viaList = (await listRegisteredTools(tc.ctx)).some((d) => d.name === tool);
        const viaCheck = await isToolRegistered(tc.ctx, tool);
        expect(viaCheck, `${tool}, withRemote=${withRemote}`).toBe(withRemote);
        expect(viaCheck).toBe(viaList);
      }
      await tc.cleanup();
    }
  });

  it("aart_deploy stays present with ZERO remotes configured -- the deliberate exception (D1, AMENDMENTS.md A56), NOT added to REMOTE_GATED_TOOLS", async () => {
    tc = await createTestContext();
    await expect(tc.ctx.remotes.list()).resolves.toEqual({});
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).toContain("aart_deploy");
  });
});

// Wave 2C (AMENDMENTS.md A65) — aart_remote_approve is the FIRST tool in
// this codebase needing TWO independent preconditions, not one: combines
// aart_approve's own trust-mode gate (isAartApproveRegisteredForMode) with
// REMOTE_GATED_TOOLS' own "≥1 configured remote" precondition above — a
// caller denied LOCAL approval in strict/production must not gain a remote
// escape hatch around that restriction. Every assertion here goes through
// listRegisteredTools directly, matching this file's own load-bearing DoD
// note at the top (a mode-gated tool's absence is proven in the tool LIST,
// not just at call time).
describe("aart_remote_approve — TWO independent preconditions: trust mode AND >=1 configured remote (AMENDMENTS.md A65, Wave 2C)", () => {
  it("absent with zero configured remotes, even in dev mode (where aart_approve itself IS registered)", async () => {
    tc = await createTestContext({ trustMode: "dev" });
    await expect(tc.ctx.remotes.list()).resolves.toEqual({});
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).not.toContain("aart_remote_approve");
  });

  it("absent in strict mode even with a remote configured", async () => {
    tc = await createTestContext({ trustMode: "strict" });
    await writeRemote(tc.root);
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).not.toContain("aart_remote_approve");
  });

  it("absent in production mode even with a remote configured", async () => {
    tc = await createTestContext({ trustMode: "production" });
    await writeRemote(tc.root);
    const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
    expect(names).not.toContain("aart_remote_approve");
  });

  it("present only once BOTH preconditions hold: dev/governed mode AND >=1 configured remote", async () => {
    for (const mode of ["dev", "governed"] as const) {
      tc = await createTestContext({ trustMode: mode });
      await writeRemote(tc.root);
      const names = (await listRegisteredTools(tc.ctx)).map((d) => d.name);
      expect(names, `trust mode ${mode}`).toContain("aart_remote_approve");
      await tc.cleanup();
    }
  });

  it("isToolRegistered agrees with listTools across the full mode x remote-configured matrix", async () => {
    for (const mode of ["dev", "governed", "strict", "production"] as const) {
      for (const withRemote of [false, true]) {
        tc = await createTestContext({ trustMode: mode });
        if (withRemote) await writeRemote(tc.root);
        const expected = (mode === "dev" || mode === "governed") && withRemote;
        const viaList = (await listRegisteredTools(tc.ctx)).some((d) => d.name === "aart_remote_approve");
        const viaCheck = await isToolRegistered(tc.ctx, "aart_remote_approve");
        expect(viaCheck, `mode=${mode}, withRemote=${withRemote}`).toBe(expected);
        expect(viaCheck).toBe(viaList);
        await tc.cleanup();
      }
    }
  });

  it("in strict mode with a remote configured, callTool also refuses aart_remote_approve (belt-and-suspenders, but listTools is the load-bearing check)", async () => {
    tc = await createTestContext({ trustMode: "strict" });
    await writeRemote(tc.root);
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_remote_approve", { remote: "staging", taskId: "x", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
  });

  it("in dev mode with zero remotes configured, callTool also refuses aart_remote_approve (belt-and-suspenders, but listTools is the load-bearing check)", async () => {
    tc = await createTestContext({ trustMode: "dev" });
    const server = createMcpServer(tc.ctx);
    const result = await server.callTool("aart_remote_approve", { remote: "staging", taskId: "x", decision: "approved", reviewer: "alice" });
    expect(result.ok).toBe(false);
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
