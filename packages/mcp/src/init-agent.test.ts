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
    for (const tool of ["aart_find_blocks", "aart_register_block", "aart_validate", "aart_run_workflow", "aart_get_report", "aart_verify"]) {
      expect(instructions).toContain(tool);
    }
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
