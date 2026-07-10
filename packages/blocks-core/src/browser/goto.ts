// browser.goto — spec §15.3 Browser group. The one browser.* block that
// originates a NEW navigation to a caller-resolved URL, so it's one of the
// egress-allowlist chokepoints (architecture §4.6 boundary note / ADR-09)
// alongside http.request/http.download/http.health_check/web.read — the
// other 9 browser.* blocks act on the already-navigated page for this run
// and don't independently resolve a new origin.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { checkEgressAllowed } from "../lib/egress.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  url: z.string().describe("The URL to navigate to."),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional().describe('Playwright navigation-completion signal. Defaults to "load".'),
});
const outputSchema = z.object({
  url: z.string().describe("The page's URL after navigation (may differ from the requested url after a redirect)."),
  title: z.string(),
  status: z.number().nullable().describe("HTTP status of the navigation response, or null if unavailable."),
});

export const browserGotoBlock = defineBlock({
  id: "browser.goto",
  capabilities: ["browser"],
  category: "browser",
  description: 'Navigates this run\'s browser page to a URL. Example: url: "https://example.com/login". Subsequent browser.* steps in the same run act on the resulting page.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    checkEgressAllowed(input.url);
    const page = await getOrCreatePage(ctx.runId);
    const response = await page.goto(input.url, { waitUntil: input.waitUntil ?? "load" });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  },
});
