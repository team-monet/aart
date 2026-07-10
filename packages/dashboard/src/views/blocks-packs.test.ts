import { describe, expect, it } from "vitest";
import { renderBlocksPage, renderPacksPage } from "./blocks-packs.js";

describe("Blocks / Packs pages — honest pending-integration stubs", () => {
  it("renderBlocksPage clearly states the pending integration rather than fabricating data", () => {
    const html = renderBlocksPage();
    expect(html).toContain("Pending");
    expect(html).toContain("@aart/blocks-core");
  });

  it("renderPacksPage clearly states the pending integration rather than fabricating data", () => {
    const html = renderPacksPage();
    expect(html).toContain("Pending");
  });
});
