// init-agent tests — spec §33.1 / architecture §10.4. DoD: "generates MCP
// config JSON + agent instruction file; instruction file content includes
// the motivation-leading tool-description framing ('Shell runs and is
// forgotten...') as validated prior art from the v0.x prototype."
import { describe, expect, it } from "vitest";
import { generateInitAgentOutputs } from "./init-agent.js";

describe("generateInitAgentOutputs", () => {
  it("generates an MCP config pointing at `npx @team-monet/aart mcp` (spec §27.2's exact shape)", () => {
    const { mcpConfig } = generateInitAgentOutputs();
    expect(mcpConfig.mcpServers.aart).toEqual({ command: "npx", args: ["-y", "@team-monet/aart", "mcp"] });
  });

  it("mcpConfigJson is valid, pretty-printed JSON matching mcpConfig", () => {
    const { mcpConfig, mcpConfigJson } = generateInitAgentOutputs();
    expect(JSON.parse(mcpConfigJson)).toEqual(mcpConfig);
    expect(mcpConfigJson).toContain("\n");
  });

  it("respects a custom package name", () => {
    const { mcpConfig } = generateInitAgentOutputs({ packageName: "@custom/aart" });
    expect(mcpConfig.mcpServers.aart.args).toEqual(["-y", "@custom/aart", "mcp"]);
  });

  it("pins an explicit store root and adapter into either MCP launch form", () => {
    const npx = generateInitAgentOutputs({ root: "/work/shared/.aart", store: "sqlite" }).mcpConfig;
    expect(npx.mcpServers.aart.args).toEqual(["-y", "@team-monet/aart", "mcp", "--root", "/work/shared/.aart", "--store", "sqlite"]);
    const direct = generateInitAgentOutputs({ binPath: "/opt/aart/dist/bin.js", root: "/work/shared/.aart", store: "fs" }).mcpConfig;
    expect(direct.mcpServers.aart.args).toEqual(["/opt/aart/dist/bin.js", "mcp", "--root", "/work/shared/.aart", "--store", "fs"]);
  });

  describe("binPath (AMENDMENTS.md A54 — the npx-registry trap)", () => {
    it("given a binPath, points the MCP config straight at it via `node`, not `npx`", () => {
      const { mcpConfig } = generateInitAgentOutputs({ binPath: "/opt/aart/dist/bin.js" });
      expect(mcpConfig.mcpServers.aart).toEqual({ command: "node", args: ["/opt/aart/dist/bin.js", "mcp"] });
    });

    it("can pin the Node executable that is ABI-compatible with the generating install", () => {
      const { mcpConfig } = generateInitAgentOutputs({ binPath: "/opt/aart/dist/bin.js", nodePath: "/opt/node-v22/bin/node" });
      expect(mcpConfig.mcpServers.aart).toEqual({ command: "/opt/node-v22/bin/node", args: ["/opt/aart/dist/bin.js", "mcp"] });
    });

    it("without a binPath, still falls back to the original npx/registry form (this function's own default; @team-monet/aart's CLI is the layer that always supplies binPath for real invocations — see init-agent.ts's header comment)", () => {
      const { mcpConfig } = generateInitAgentOutputs();
      expect(mcpConfig.mcpServers.aart.command).toBe("npx");
    });

    it("packageName is ignored once binPath is given — the config names a file, not a package", () => {
      const { mcpConfig } = generateInitAgentOutputs({ binPath: "/opt/aart/dist/bin.js", packageName: "@custom/aart" });
      expect(mcpConfig.mcpServers.aart.args).toEqual(["/opt/aart/dist/bin.js", "mcp"]);
    });

    it("mcpConfigJson still round-trips through JSON.parse to mcpConfig in the binPath form", () => {
      const { mcpConfig, mcpConfigJson } = generateInitAgentOutputs({ binPath: "/opt/aart/dist/bin.js" });
      expect(JSON.parse(mcpConfigJson)).toEqual(mcpConfig);
    });
  });

  it("instructions embed the motivation-leading quote verbatim (v0.x prototype prior art, architecture §10.4)", () => {
    const { instructions } = generateInitAgentOutputs();
    expect(instructions).toContain("Shell runs and is forgotten. AART runs and is kept.");
  });

  it("instructions front-load the framing, not bury it in a tool description only — it appears near the top of the document", () => {
    const { instructions } = generateInitAgentOutputs();
    const index = instructions.indexOf("Shell runs and is forgotten");
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(200);
  });

  it("instructions describe the authoring loop using real aart_* tool names", () => {
    const { instructions } = generateInitAgentOutputs();
    for (const tool of ["aart_find_tools", "aart_check_tool", "aart_run_tool", "aart_list_tool_runs", "aart_get_tool_run", "aart_find_workflows", "aart_find_blocks", "aart_register_block", "aart_validate", "aart_run_workflow", "aart_get_report", "aart_verify"]) {
      expect(instructions).toContain(tool);
    }
  });

  it("instructions make reuse-first co-authoring and unattended server execution one lifecycle", () => {
    const { instructions } = generateInitAgentOutputs();
    expect(instructions).toContain("Search before you build");
    expect(instructions).toContain("Creating a different implementation every session is a product failure");
    expect(instructions).toContain("deterministic and unattended");
  });

  it("instructions' approval section varies by trust mode (strict/production explicitly say aart_approve is not registered)", () => {
    const dev = generateInitAgentOutputs({ trustMode: "dev" }).instructions;
    const strict = generateInitAgentOutputs({ trustMode: "strict" }).instructions;
    const production = generateInitAgentOutputs({ trustMode: "production" }).instructions;
    expect(dev).not.toContain("not registered");
    expect(strict).toContain("not registered");
    expect(production).toContain("not registered");
  });

  it("defaults to governed mode when none is specified (spec §17.2's stated local-dev default)", () => {
    const { instructions } = generateInitAgentOutputs();
    expect(instructions).toContain("governed");
  });
});
