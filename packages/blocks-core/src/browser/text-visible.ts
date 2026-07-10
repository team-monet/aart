// browser.text_visible — spec §15.3 Browser group boundary note: this is a
// SENSOR (returns a boolean, used inside if:/assert.* conditions), NOT an
// assertion — it must never throw just because the element isn't visible.
// Distinct from browser.extract_text (selector-scoped raw extraction, which
// DOES throw on a bad selector) and web.read (high-level main-content read).
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  selector: z.string(),
});
const outputSchema = z.object({
  visible: z.boolean(),
});

export const browserTextVisibleBlock = defineBlock({
  id: "browser.text_visible",
  capabilities: ["browser"],
  category: "browser",
  description:
    'Sensor: reports whether an element matching selector is currently visible, without failing the run either way. Example: selector: "text=Success". Use assert.contains/assert.equals if you want the run to fail on a mismatch.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    const visible = await page.isVisible(input.selector);
    return { visible };
  },
});
