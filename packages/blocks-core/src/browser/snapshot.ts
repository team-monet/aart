// browser.snapshot — spec §15.3 Browser group. A structured
// accessibility-tree read of the page. Playwright's old `page.accessibility
// .snapshot()` API is GONE in the installed playwright@1.61.1 (confirmed by
// direct probe during this session: `typeof page.accessibility ===
// "undefined"`) — its documented replacement, `locator.ariaSnapshot()`, is
// used instead. It returns a YAML-formatted string (not an arbitrary JSON
// tree), hence `snapshot: string` below, not `snapshot: unknown`.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({});
const outputSchema = z.object({
  snapshot: z.string().describe("A YAML-formatted accessibility-tree snapshot of the page (Playwright's ariaSnapshot format)."),
});

export const browserSnapshotBlock = defineBlock({
  id: "browser.snapshot",
  capabilities: ["browser"],
  category: "browser",
  description: 'Returns a structured accessibility-tree snapshot of this run\'s current page — useful for an agent to see interactive elements without a screenshot. Example: with: {} (no parameters).',
  inputSchema,
  outputSchema,
  execute: async (_input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    const snapshot = await page.locator("body").ariaSnapshot();
    return { snapshot };
  },
});
