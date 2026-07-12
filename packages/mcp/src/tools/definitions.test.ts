import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../response.js";
import { getToolDefinition, TOOL_DEFINITIONS } from "./definitions.js";

describe("TOOL_DEFINITIONS", () => {
  it("has exactly one definition per tool name, no more no less", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(26); // 21 + D1's aart_deploy (AMENDMENTS.md A56) + D2b's four aart_remote_* read tools (AMENDMENTS.md, this session)
    expect([...TOOL_DEFINITIONS.map((d) => d.name)].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("every description is non-empty and answers when-to-use (architecture §32.2a) — a length floor as a cheap proxy", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.description.length).toBeGreaterThan(40);
    }
  });

  it("every tool has a Zod object input schema", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.inputSchema).toBeDefined();
      expect(typeof def.inputSchema.safeParse).toBe("function");
    }
  });

  it("getToolDefinition throws for an unknown name", () => {
    // @ts-expect-error deliberately invalid tool name for this test
    expect(() => getToolDefinition("not_a_real_tool")).toThrow();
  });

  it("getToolDefinition returns the matching definition", () => {
    expect(getToolDefinition("aart_verify").name).toBe("aart_verify");
  });
});
