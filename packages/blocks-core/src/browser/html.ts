// browser.html — spec §15.3 Browser group.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string().optional().describe("If omitted, returns the full page HTML (page.content()); otherwise the matched element's innerHTML."),
});
const outputSchema = z.object({
  html: z.string(),
});

export const browserHtmlBlock = defineBlock({
  id: "browser.html",
  capabilities: ["browser"],
  category: "browser",
  description: 'Returns HTML from this run\'s current page. Example: selector: "#results" for one element\'s innerHTML, or omit selector for the whole page.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    const html = input.selector ? await page.innerHTML(input.selector) : await page.content();
    return { html };
  },
});
