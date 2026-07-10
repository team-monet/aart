import { describe, expect, it } from "vitest";
import type { BlockManifest } from "@aart/types";
import { renderBlocksPage, renderPacksPage } from "./blocks-packs.js";

function fixtureManifest(overrides: Partial<BlockManifest> = {}): BlockManifest {
  return {
    id: "http.request",
    version: "1.0.0",
    capabilities: ["http"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    description: "Makes an HTTP request.",
    category: "http",
    ...overrides,
  };
}

describe("Blocks page — S9 integration (reconciliation ledger item 13): renders the real block catalog", () => {
  it("renders each manifest's id, category, capabilities, and description", () => {
    const html = renderBlocksPage([fixtureManifest(), fixtureManifest({ id: "command.run", capabilities: ["command"], category: "command", description: "Runs a shell command." })]);
    expect(html).toContain("http.request");
    expect(html).toContain("command.run");
    expect(html).toContain("command");
    expect(html).toContain("Runs a shell command.");
  });

  it("sorts by block id for deterministic rendering", () => {
    const html = renderBlocksPage([fixtureManifest({ id: "z.block" }), fixtureManifest({ id: "a.block" })]);
    expect(html.indexOf("a.block")).toBeLessThan(html.indexOf("z.block"));
  });

  it("an empty catalog renders without error", () => {
    expect(renderBlocksPage([])).toContain("0 block(s)");
  });
});

describe("Packs page — honest pending-integration stub (reconciliation ledger item 13's remaining, still-open gap — see item 12's identical blocker)", () => {
  it("renderPacksPage clearly states the pending integration rather than fabricating data", () => {
    const html = renderPacksPage();
    expect(html).toContain("Pending");
  });
});
