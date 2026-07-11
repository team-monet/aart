import { describe, expect, it } from "vitest";
import type { BlockManifest } from "@aart/types";
import { renderBlockDetailPage, renderBlocksPage, renderPacksPage } from "./blocks-packs.js";

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

  // root AMENDMENTS.md A43: block detail was previously unreachable from
  // anywhere in the dashboard — no link existed at all.
  it("links each block id to its detail page", () => {
    const html = renderBlocksPage([fixtureManifest({ id: "http.request" })]);
    expect(html).toContain('<a href="/blocks/http.request">http.request</a>');
  });
});

describe("Block detail page (root AMENDMENTS.md A43 — previously never built: no route, no view, no link)", () => {
  it("renders version, category, description, capabilities, and both schemas", () => {
    const html = renderBlockDetailPage(fixtureManifest({ id: "http.request", version: "1.2.0", capabilities: ["http", "network"], inputSchema: { type: "object", properties: { url: { type: "string" } } } }));
    expect(html).toContain("http.request");
    expect(html).toContain("1.2.0");
    expect(html).toContain("http");
    expect(html).toContain("Makes an HTTP request.");
    expect(html).toContain("network");
    expect(html).toContain("&quot;url&quot;"); // input schema rendered (HTML-escaped like every other dynamic field on this page), not just referenced
  });

  it("a block with no declared capabilities renders an honest '(none)' rather than an empty list", () => {
    expect(renderBlockDetailPage(fixtureManifest({ capabilities: [] }))).toContain("(none)");
  });
});

describe("Packs page — honest pending-integration stub (reconciliation ledger item 13's remaining, still-open gap — see item 12's identical blocker)", () => {
  it("renderPacksPage clearly states the pending integration rather than fabricating data", () => {
    const html = renderPacksPage();
    expect(html).toContain("Pending");
  });
});
