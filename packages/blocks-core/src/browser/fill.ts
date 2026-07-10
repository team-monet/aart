// browser.fill — spec §15.3 Browser group.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string().describe('A CSS or Playwright selector, e.g. "#email".'),
  value: z.string(),
  timeoutMs: z.number().optional(),
});
const outputSchema = z.object({
  filled: z.literal(true),
  selector: z.string(),
});

export const browserFillBlock = defineBlock({
  id: "browser.fill",
  capabilities: ["browser"],
  category: "browser",
  description: 'Fills a form input on this run\'s current page. Example: selector: "#email", value: "a@b.com".',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    await page.fill(input.selector, input.value, { timeout: input.timeoutMs });
    return { filled: true as const, selector: input.selector };
  },
});
