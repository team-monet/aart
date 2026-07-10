// browser.back — spec §15.3 Browser group. Acts on the run's existing page
// (no navigation to a new caller-resolved origin, so no egress check —
// same reasoning as browser.click).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({});
const outputSchema = z.object({
  url: z.string(),
  title: z.string(),
});

export const browserBackBlock = defineBlock({
  id: "browser.back",
  capabilities: ["browser"],
  category: "browser",
  description: "Navigates this run's browser page back in its history. Example: with: {} (no parameters).",
  inputSchema,
  outputSchema,
  execute: async (_input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    await page.goBack();
    return { url: page.url(), title: await page.title() };
  },
});
