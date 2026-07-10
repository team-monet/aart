// browser.screenshot — spec §15.3 Browser group. capabilities
// ["browser", "file.write"] — the one Browser block writing an artifact
// (mirrors http.download's ["http", "file.write"] pairing), so it needs
// both. `maskSelectors` (architecture §15 micro-decision #46, threat-model
// §15 row "Secret exfiltration paths") blacks out matching DOM regions
// BEFORE capture — a first-class prevention, since the redaction
// chokepoint (ADR-10) cannot un-redact pixels already rendered into a
// bitmap ("text-based redaction doesn't work on a bitmap").
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string().optional().describe("If given, screenshots only this element; otherwise the full viewport (or full page if fullPage is set)."),
  fullPage: z.boolean().optional(),
  maskSelectors: z.array(z.string()).optional().describe("Selectors to black out before capture — use for any region that might render a secret."),
});
const outputSchema = z.object({
  id: z.string(),
  path: z.string(),
});

export const browserScreenshotBlock = defineBlock({
  id: "browser.screenshot",
  capabilities: ["browser", "file.write"],
  category: "browser",
  description:
    'Captures a screenshot artifact of this run\'s current page. Example: fullPage: true, maskSelectors: ["#api-key-display"] blacks out that region before capture.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    const mask = input.maskSelectors?.map((selector) => page.locator(selector));

    const buffer = input.selector
      ? await page.locator(input.selector).screenshot({ mask })
      : await page.screenshot({ fullPage: input.fullPage, mask });

    const written = await ctx.writeArtifact({ name: "screenshot.png", kind: "screenshot", mime: "image/png", bytes: new Uint8Array(buffer) });
    return { id: written.id, path: written.path };
  },
});
