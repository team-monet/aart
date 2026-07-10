// assert.no_console_errors — spec §15.3 Assert group. Capability
// ["browser"] — reads THIS run's live browser-session console-error
// tracking (lib/browser-session.ts), unlike the other capability-free
// assert.* blocks. If no browser session exists yet for this run (no
// browser.*/web.read block has executed), treated as vacuously zero
// errors — not an error condition on its own.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { assertOrThrow } from "../lib/assertion.js";
import { getConsoleErrors } from "../lib/browser-session.js";

const inputSchema = z.object({});
const outputSchema = z.object({
  passed: z.literal(true),
  errors: z.array(z.string()),
});

export const assertNoConsoleErrorsBlock = defineBlock({
  id: "assert.no_console_errors",
  capabilities: ["browser"],
  category: "assert",
  description: "Fails the run if this run's browser session logged any console errors or uncaught page errors. Example: with: {} (no parameters) — run after your browser.*/web.read steps.",
  inputSchema,
  outputSchema,
  execute: async (_input, ctx) => {
    const errors = getConsoleErrors(ctx.runId) ?? [];
    assertOrThrow("assert.no_console_errors", errors.length === 0, `${errors.length} console error(s): ${errors.join("; ")}`, { errors });
    return { passed: true as const, errors };
  },
});
