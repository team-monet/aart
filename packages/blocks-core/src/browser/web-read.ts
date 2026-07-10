// web.read — spec §15.3, grouped into the Browser catalog group per this
// session's plan (web folded into Browser) even though its wire id is
// `web.read`, not `browser.*`. The high-level "what's on this page" read —
// distinct from browser.extract_text's selector-scoped raw extraction and
// browser.text_visible's boolean sensor (spec §15.3 boundary note). One of
// the egress-allowlist chokepoints (architecture §4.6 boundary note /
// ADR-09) alongside http.request/http.download/http.health_check/
// browser.goto, since an explicit `url` here triggers a fresh navigation
// to a caller-resolved origin.
import { z } from "zod";
import { defineBlock } from "../lib/define-block.js";
import { getOrCreatePage } from "../lib/browser-session.js";
import { checkEgressAllowed } from "../lib/egress.js";

// In-page extraction, passed to page.evaluate as a STRING rather than a
// typed arrow function: this package's tsconfig has `lib: ["ES2023"]` only
// (no "dom" — confirmed via an isolated tsc probe against this exact
// snippet), so a literal function referencing `document`/`HTMLElement`
// fails to type-check here (TS2584/TS2304) even though it runs fine
// inside the page's real DOM. A string is evaluated by Playwright as an
// in-page expression, sidestepping that without touching this package's
// frozen tsconfig — the same "script travels as a string, not as TS
// source" idea browser.eval uses for caller-supplied scripts. (Runtime
// behavior confirmed against playwright@1.61.1: this exact script returns
// the <main>/<article> text when present, and falls back to <body>
// otherwise.)
const MAIN_CONTENT_SCRIPT =
  "(() => { const main = document.querySelector('main, article') || document.body; return main ? main.innerText : ''; })()";

const inputSchema = z.object({
  url: z.string().optional().describe("If given, navigates there first; otherwise reads this run's current page."),
});
const outputSchema = z.object({
  text: z.string(),
  url: z.string(),
  title: z.string(),
});

export const webReadBlock = defineBlock({
  id: "web.read",
  capabilities: ["browser"],
  category: "browser",
  description:
    'The model-friendly default when an agent just wants "what\'s on this page" — extracts main-content text (prefers <main>/<article>, falls back to <body>). Example: url: "https://example.com/article". Omit url to read the run\'s current page.',
  inputSchema,
  outputSchema,
  execute: async (input, ctx) => {
    if (input.url) {
      checkEgressAllowed(input.url);
    }
    const page = await getOrCreatePage(ctx.runId);
    if (input.url) {
      await page.goto(input.url, { waitUntil: "load" });
    }
    const text = await page.evaluate<string>(MAIN_CONTENT_SCRIPT);
    return { text, url: page.url(), title: await page.title() };
  },
});
