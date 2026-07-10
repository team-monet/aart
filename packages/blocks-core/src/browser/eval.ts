// browser.eval — spec §15.3 Browser group. `script` is the BODY of a
// function (e.g. "return document.title"), not a full function
// expression — built into a real function via `new Function` and handed
// to Playwright's page.evaluate, which serializes `arg` across the
// isolate boundary and returns the (JSON-serializable) result.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";

const inputSchema = z.object({
  script: z.string().describe('JS function BODY, e.g. "return document.title" or "return arg * 2".'),
  arg: z.unknown().optional(),
});
const outputSchema = z.object({
  result: z.unknown(),
});

export const browserEvalBlock = defineBlock({
  id: "browser.eval",
  capabilities: ["browser"],
  category: "browser",
  description: 'Runs custom JavaScript in the page context and returns its (JSON-serializable) result. Example: script: "return document.querySelectorAll(\'.item\').length".',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    const page = await getOrCreatePage(ctx.runId);
    let fn: (arg: unknown) => unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- deliberate: this IS the block's job (governed by the `browser` capability grant + approval pipeline, not something to sanitize away)
      fn = new Function("arg", input.script) as (arg: unknown) => unknown;
    } catch (cause) {
      throw new Error(`browser.eval: script is not valid JavaScript — ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    const result = await page.evaluate(fn, input.arg);
    return { result };
  },
});
