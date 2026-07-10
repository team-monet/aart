// browser.click — spec §15.3 Browser group. Acts on the run's EXISTING
// page (browser-session.ts's per-runId continuity) rather than navigating
// anywhere itself — no egress check here (contrast browser.goto): this
// block never resolves a new origin, it only interacts with whatever page
// a prior browser.goto (or web.read) already navigated to.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string().describe('A CSS or Playwright selector, e.g. "#submit" or "text=Sign in".'),
  timeoutMs: z.number().optional().describe("Max time to wait for the element to become clickable. Defaults to Playwright's own default (30000ms)."),
});
const outputSchema = z.object({
  clicked: z.literal(true),
  selector: z.string(),
});

export const browserClickBlock = defineBlock({
  id: "browser.click",
  capabilities: ["browser"],
  category: "browser",
  description: 'Clicks an element on this run\'s current page, identified by selector. Example: selector: "#submit". Navigate there first with browser.goto.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    await page.click(input.selector, { timeout: input.timeoutMs });
    return { clicked: true, selector: input.selector };
  },
});
