// browser.extract_text — spec §15.3 Browser group boundary note:
// selector-scoped RAW extraction (throws if selector doesn't match) —
// distinct from web.read (high-level main-content read) and
// browser.text_visible (a non-throwing boolean sensor).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string().describe('A CSS or Playwright selector identifying the element to extract text from, e.g. "#total".'),
  timeoutMs: z.number().optional().describe("Defaults to Playwright's own default (30000ms)."),
});
const outputSchema = z.object({
  text: z.string(),
});

export const browserExtractTextBlock = defineBlock({
  id: "browser.extract_text",
  capabilities: ["browser"],
  category: "browser",
  description: 'Extracts the raw text content of a specific element. Example: selector: "#total". Throws (after waiting up to timeoutMs) if selector matches nothing — use browser.text_visible first if the element\'s presence is uncertain.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    const text = await page.textContent(input.selector, { timeout: input.timeoutMs });
    return { text: text ?? "" };
  },
});
